import {
	IconArrowRight,
	IconCheck,
	IconCircleDashed,
	IconExternalLink,
	IconGlobe,
	IconLogout,
	IconPlus,
	IconRefresh,
	IconSparkles,
} from "@tabler/icons-react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { authClient } from "@workspace/lib/auth/client";
import { parseGoogleMapsLocation } from "@workspace/lib/google-maps-location";
import type { CycleDiffChange } from "@workspace/lib/selena-cycle-diff";
import type { LedgerReport } from "@workspace/lib/selena-ledger-metrics";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useEffect, useMemo, useState } from "react";
import { SelenaWordmark } from "@/components/selena-wordmark";
import { useAuth } from "@/hooks/use-auth";
import { validateWebsiteUrl } from "@/lib/brand-website";
import { resetPostHog } from "@/lib/posthog";
import { formatShare, type GroupView, groupView } from "@/lib/selena-measurement-view";
import { ruleExample, ruleFixTask, ruleHow, ruleSteps, ruleTitle } from "@/lib/selena-rule-help";
import { SUGGESTION_LIMITS } from "@/lib/selena-suggestion";
import { humanizeSelenaError } from "@/lib/selena-workspace-errors";
import { getSelenaAdminAccessFn } from "../../../server/selena-admin-orders";
import { createSelenaProjectFn, getSelenaWorkspaceFn } from "../../../server/selena-client";
import { type CycleCompareResult, getSelenaCycleCompareFn } from "../../../server/selena-cycle-compare";
import { getSelenaMeasurementFn, type MeasurementView } from "../../../server/selena-measurement-view";
import {
	cancelSelenaProfileSuggestionFn,
	confirmSelenaProfileFn,
	getSelenaProfileSuggestionFn,
	startSelenaProfileSuggestionFn,
} from "../../../server/selena-onboarding";
import { prepareSelenaScenariosFn } from "../../../server/selena-order-desk";
import {
	getSelenaRunDetailFn,
	listSelenaRunsFn,
	type RunDetail,
	type RunListItem,
} from "../../../server/selena-run-explorer";
import {
	listSelenaScenariosFn as getSelenaScenariosListFn,
	reviewSelenaScenarioFn,
	type ScenarioListItem,
} from "../../../server/selena-scenarios";
import { collectSelenaWebsiteFn } from "../../../server/selena-website-collector";

export const Route = createFileRoute("/_authed/app/selena")({
	loader: async () => ({
		workspace: await getSelenaWorkspaceFn(),
		// The owner runs measurements from the order desk, not by sending
		// herself a request. Knowing who is looking is what lets the plan card
		// point at the right door.
		access: await getSelenaAdminAccessFn(),
	}),
	pendingComponent: WorkspaceSkeleton,
	component: SelenaWorkspace,
});

type WorkspaceData = Awaited<ReturnType<typeof getSelenaWorkspaceFn>>;
type WorkspaceProject = WorkspaceData["projects"][number];
type WorkspaceLocale = "en" | "ru";
type ActionScope = "project" | "profile" | "website" | "";

/** How long to keep polling a suggestion before calling it stuck. */
const SUGGESTION_POLL_MS = 4000;
const SUGGESTION_TIMEOUT_MS = 180_000;

const emptyProjectForm = { name: "", category: "", country: "ID", region: "", languages: "en" };
const emptyProfileForm = {
	brandName: "",
	primaryDomain: "",
	mapsLocation: "",
	publicProfiles: "",
	competitors: "",
	scenarios: "",
};

function SelenaWorkspace() {
	const { workspace, access } = Route.useLoaderData();
	const { projects } = workspace;
	const router = useRouter();
	const { user } = useAuth();
	const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.project.id ?? "");
	const [showCreate, setShowCreate] = useState(projects.length === 0);
	const [projectForm, setProjectForm] = useState(emptyProjectForm);
	const [profileForm, setProfileForm] = useState(emptyProfileForm);
	const [pendingAction, setPendingAction] = useState<ActionScope>("");
	// Feedback is rendered beside the control that produced it: a single banner
	// at the top of the page sits off-screen when the customer is at the button.
	const [feedbackScope, setFeedbackScope] = useState<ActionScope>("");
	const [suggesting, setSuggesting] = useState(false);
	// The suggestion lands as a draft to tick through, never as silently
	// replaced fields: the customer picks what they agree with.
	const [suggestion, setSuggestion] = useState<{ competitors: string[]; questions: string[] } | null>(null);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [locale, setLocale] = useState<WorkspaceLocale>("en");

	const selectedProject = useMemo(
		() => projects.find((item) => item.project.id === selectedProjectId) ?? projects[0] ?? null,
		[projects, selectedProjectId],
	);

	useEffect(() => {
		if (!selectedProject && projects[0]) setSelectedProjectId(projects[0].project.id);
	}, [projects, selectedProject]);

	useEffect(() => {
		const savedLocale = window.localStorage.getItem("selena-workspace-locale");
		const nextLocale =
			savedLocale === "ru" || savedLocale === "en" ? savedLocale : navigator.language.startsWith("ru") ? "ru" : "en";
		setLocale(nextLocale);
		document.documentElement.lang = nextLocale;
	}, []);

	useEffect(() => {
		if (!selectedProject?.profile) {
			setProfileForm(emptyProfileForm);
			return;
		}
		setProfileForm({
			brandName: selectedProject.profile.brandName,
			primaryDomain: selectedProject.profile.primaryDomain,
			mapsLocation: readObjectString(selectedProject.profile.mapsLocation, "url"),
			publicProfiles: selectedProject.profile.publicProfiles
				.map((item) => readObjectString(item, "url"))
				.filter(Boolean)
				.join(", "),
			competitors: selectedProject.profile.competitors
				.map((item) => readObjectString(item, "name"))
				.filter(Boolean)
				.join(", "),
			scenarios: selectedProject.profile.scenarios
				.map((item) => {
					const text = readObjectString(item, "text");
					const language = readObjectString(item, "language");
					return text ? `${language ? `${language.toUpperCase()}: ` : ""}${text}` : "";
				})
				.filter(Boolean)
				.join("\n"),
		});
	}, [selectedProject]);

	const refreshWorkspace = async () => {
		await router.invalidate();
	};

	const onProfileNormalized = (patch: Partial<typeof emptyProfileForm>) =>
		setProfileForm((current) => ({ ...current, ...patch }));

	// Research runs in the worker (roughly a minute), so the page polls for it.
	// `auto` is the confirm-with-empty-questions path: confirming the profile is
	// the deliberate action, so it may start the paid suggestion; the questions
	// still come back as a draft and the profile is confirmed on a second,
	// informed click.
	const runSuggestion = async (auto: boolean) => {
		if (!selectedProject || suggesting) return;
		const website = validateWebsiteUrl(profileForm.primaryDomain);
		if (!website.isValid) {
			setFeedbackScope("profile");
			setError(
				tr(
					locale,
					"Enter the primary website first — the suggestion is read from it.",
					"Сначала укажите основной сайт — подбор читает именно его.",
				),
			);
			return;
		}
		// The location is optional for the suggestion, but a filled-in link that
		// cannot be read should stop here rather than silently degrade the result.
		let mapsLocationUrl = "";
		if (profileForm.mapsLocation.trim()) {
			const maps = parseGoogleMapsLocation(profileForm.mapsLocation);
			if (!maps.isValid) {
				setFeedbackScope("profile");
				setError(
					tr(
						locale,
						"«Google Maps location»: we could not read the link. Paste your place's share link, for example https://maps.app.goo.gl/…",
						"«Локация в Google Maps»: ссылка не распознана. Вставьте ссылку «Поделиться» вашей точки, например https://maps.app.goo.gl/…",
					),
				);
				return;
			}
			mapsLocationUrl = maps.location.url;
		}
		const projectId = selectedProject.project.id;
		setFeedbackScope("profile");
		setError("");
		setNotice(
			auto
				? tr(
						locale,
						"Picking customer questions from the website — about a minute. Review them below, then confirm the profile.",
						"Подбираем вопросы по сайту — около минуты. Они появятся ниже: поправьте и подтвердите профиль.",
					)
				: "",
		);
		setSuggesting(true);
		try {
			await startSelenaProfileSuggestionFn({ data: { projectId, website: website.formattedUrl, mapsLocationUrl } });
			const deadline = Date.now() + SUGGESTION_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, SUGGESTION_POLL_MS));
				const result = await getSelenaProfileSuggestionFn({ data: { projectId } });
				if (result.status === "failed") throw new Error(result.error);
				if (result.status === "done") {
					onProfileNormalized({ primaryDomain: website.formattedUrl });
					setSuggestion({
						competitors: result.competitors
							.split(",")
							.map((item) => item.trim())
							.filter(Boolean),
						questions: result.questions
							.split("\n")
							.map((item) => item.trim())
							.filter(Boolean),
					});
					setNotice(
						tr(
							locale,
							"Done: tick the competitors and questions you agree with, then accept the selection.",
							"Готово: отметьте галочками конкурентов и вопросы, с которыми согласны, и примите выбранное.",
						),
					);
					return;
				}
			}
			await cancelSelenaProfileSuggestionFn({ data: { projectId } }).catch(() => {});
			setError(
				tr(
					locale,
					"The suggestion is taking too long. Fill the lists in by hand, or try again later.",
					"Подбор занимает слишком долго. Заполните списки вручную или попробуйте позже.",
				),
			);
		} catch (cause) {
			// The "we are picking questions" notice was set before the call, so a
			// refusal has to clear it: leaving both up tells the customer we are
			// working on something we just declined to do.
			setNotice("");
			setError(
				humanizeSelenaError(
					cause,
					locale,
					tr(
						locale,
						"We could not suggest competitors and questions. Fill them in by hand.",
						"Не удалось подобрать конкурентов и вопросы. Заполните их вручную.",
					),
				),
			);
		} finally {
			setSuggesting(false);
		}
	};

	const suggestProfile = () => runSuggestion(false);

	const createProject = async (event: React.FormEvent) => {
		event.preventDefault();
		setPendingAction("project");
		setFeedbackScope("project");
		setError("");
		setNotice("");
		try {
			const created = await createSelenaProjectFn({
				data: {
					...projectForm,
					country: projectForm.country.trim().toUpperCase(),
					region: projectForm.region.trim() || undefined,
					languages: projectForm.languages
						.split(",")
						.map((item) => item.trim())
						.filter(Boolean),
				},
			});
			setProjectForm(emptyProjectForm);
			setSelectedProjectId(created.id);
			setShowCreate(false);
			setNotice(
				tr(
					locale,
					"Project created. Complete the brand profile to prepare the website review.",
					"Проект создан. Заполните профиль бренда, чтобы подготовить проверку сайта.",
				),
			);
			await refreshWorkspace();
		} catch (cause) {
			setError(
				humanizeSelenaError(
					cause,
					locale,
					tr(
						locale,
						"We could not create this project. Please try again.",
						"Не удалось создать проект. Попробуйте ещё раз.",
					),
				),
			);
		} finally {
			setPendingAction("");
		}
	};

	const saveProfile = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!selectedProject) return;
		setFeedbackScope("profile");
		setError("");
		setNotice("");

		// Owners type "korafoodhall.com". The profile schema needs a full URL, so
		// complete it here and show the completed value back in the field rather
		// than rejecting the form over a missing scheme.
		const primary = validateWebsiteUrl(profileForm.primaryDomain);
		if (!primary.isValid) {
			setError(
				tr(
					locale,
					"«Primary website»: enter the full address, for example https://example.com",
					"«Основной сайт»: укажите полный адрес, например https://example.com",
				),
			);
			return;
		}
		let mapsLocationUrl = "";
		if (profileForm.mapsLocation.trim()) {
			const maps = parseGoogleMapsLocation(profileForm.mapsLocation);
			if (!maps.isValid) {
				setError(
					tr(
						locale,
						"«Google Maps location»: we could not read the link. Paste your place's share link, for example https://maps.app.goo.gl/…",
						"«Локация в Google Maps»: ссылка не распознана. Вставьте ссылку «Поделиться» вашей точки, например https://maps.app.goo.gl/…",
					),
				);
				return;
			}
			mapsLocationUrl = maps.location.url;
		}
		const publicProfiles: string[] = [];
		for (const input of splitList(profileForm.publicProfiles)) {
			const link = validateWebsiteUrl(input);
			if (!link.isValid) {
				setError(
					locale === "ru"
						? `«Ссылки на публичные профили»: адрес «${input}» не распознан. Укажите полный адрес, например https://instagram.com/username`
						: `«Public profile links»: we could not read «${input}». Enter the full address, for example https://instagram.com/username`,
				);
				return;
			}
			publicProfiles.push(link.formattedUrl);
		}
		onProfileNormalized({
			primaryDomain: primary.formattedUrl,
			mapsLocation: mapsLocationUrl,
			publicProfiles: publicProfiles.join(", "),
		});

		// An empty questions box is not a validation error: confirming is the
		// deliberate action, so it starts the suggestion instead, and the
		// questions come back below for the same review-then-confirm.
		const scenarioSnapshot = profileForm.scenarios
			.split("\n")
			.map((line) => parseScenario(line, selectedProject.project.languages[0] ?? "en"))
			.filter((item): item is { text: string; language: string; intentType: string } => item !== null);
		if (scenarioSnapshot.length === 0) {
			await runSuggestion(true);
			return;
		}

		setPendingAction("profile");
		try {
			await confirmSelenaProfileFn({
				data: {
					projectId: selectedProject.project.id,
					brandName: profileForm.brandName.trim(),
					primaryDomain: primary.formattedUrl,
					publicProfiles: publicProfiles.map((url) => ({ platform: "public", url })),
					mapsLocationUrl,
					competitorSnapshot: splitList(profileForm.competitors).map((name) => ({ name, domains: [] })),
					scenarioSnapshot,
				},
			});
			setNotice(
				tr(
					locale,
					"Brand profile saved. You can now review the public website.",
					"Профиль бренда сохранён. Теперь можно проверить публичный сайт.",
				),
			);
			await refreshWorkspace();
		} catch (cause) {
			setError(
				humanizeSelenaError(
					cause,
					locale,
					tr(
						locale,
						"We could not save the brand profile. Please try again.",
						"Не удалось сохранить профиль бренда. Попробуйте ещё раз.",
					),
				),
			);
		} finally {
			setPendingAction("");
		}
	};

	const collectWebsite = async () => {
		if (!selectedProject) return;
		setPendingAction("website");
		setFeedbackScope("website");
		setError("");
		setNotice("");
		try {
			const result = await collectSelenaWebsiteFn({ data: { projectId: selectedProject.project.id } });
			setNotice(
				locale === "ru"
					? `Проверка сайта завершена. Найдено рекомендаций: ${result.actionPlan.findings.length}.`
					: `Website review complete. ${result.actionPlan.findings.length} finding${result.actionPlan.findings.length === 1 ? " is" : "s are"} ready to review.`,
			);
			await refreshWorkspace();
		} catch (cause) {
			setError(
				humanizeSelenaError(
					cause,
					locale,
					tr(
						locale,
						"We could not review the confirmed website. Check the address and try again.",
						"Не удалось проверить подтверждённый сайт. Проверьте адрес и попробуйте ещё раз.",
					),
				),
			);
		} finally {
			setPendingAction("");
		}
	};

	const signOut = () => {
		authClient.signOut({
			fetchOptions: {
				onSuccess: () => {
					resetPostHog();
					window.location.href = "/auth/logout";
				},
			},
		});
	};

	return (
		<div className="selena-app min-h-screen">
			<header className="selena-app-header">
				<div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
					<div className="flex min-w-0 items-center gap-4">
						<SelenaWordmark />
						<span className="hidden h-6 w-px bg-[#d9cfc2] sm:block" aria-hidden="true" />
						<span className="hidden truncate text-sm font-medium text-[#6e6258] sm:block">
							{tr(locale, "AI Visibility", "Видимость в AI")}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Link to="/app/selena-sources" className="selena-text-button hidden sm:inline-flex">
							{tr(locale, "Sources", "Источники")}
						</Link>
						<a
							href="https://www.selenasystems.com/visibility"
							target="_blank"
							rel="noreferrer"
							className="selena-text-button hidden sm:inline-flex"
						>
							{tr(locale, "How it works", "Как это работает")} <IconExternalLink className="size-4" />
						</a>
						<fieldset className="selena-locale-switch">
							<legend className="sr-only">{tr(locale, "Interface language", "Язык интерфейса")}</legend>
							{(["en", "ru"] as const).map((option) => (
								<button
									key={option}
									type="button"
									aria-pressed={locale === option}
									onClick={() => {
										setLocale(option);
										window.localStorage.setItem("selena-workspace-locale", option);
										document.documentElement.lang = option;
									}}
								>
									{option.toUpperCase()}
								</button>
							))}
						</fieldset>
						<Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={signOut}>
							<span className="hidden max-w-40 truncate sm:inline">
								{user?.name || user?.email || tr(locale, "Account", "Аккаунт")}
							</span>
							<IconLogout className="size-4" />
							<span className="sr-only">{tr(locale, "Sign out", "Выйти")}</span>
						</Button>
					</div>
				</div>
			</header>

			<main className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[18rem_minmax(0,1fr)] lg:py-12">
				<aside className="space-y-5">
					<div>
						<h1 className="selena-heading text-3xl text-[#181614]">{tr(locale, "Your projects", "Ваши проекты")}</h1>
						<p className="mt-2 text-sm leading-6 text-[#6e6258]">
							{tr(
								locale,
								"One place for evidence, results and your action plan.",
								"Все данные, результаты и план действий в одном месте.",
							)}
						</p>
					</div>
					<Button
						type="button"
						className="selena-primary-button w-full"
						onClick={() => setShowCreate((value) => !value)}
					>
						<IconPlus className="size-4" />
						{tr(locale, "New project", "Новый проект")}
					</Button>
					<nav aria-label={tr(locale, "Projects", "Проекты")} className="selena-project-nav space-y-2">
						{projects.map((item) => {
							const selected = item.project.id === selectedProject?.project.id;
							return (
								<button
									key={item.project.id}
									type="button"
									className="selena-project-link"
									data-selected={selected || undefined}
									aria-pressed={selected}
									onClick={() => {
										setSelectedProjectId(item.project.id);
										setShowCreate(false);
										setNotice("");
										setError("");
									}}
								>
									<span className="truncate font-medium">{item.project.name}</span>
									<span className="text-xs text-[#6e6258]">{projectStageLabel(item, locale)}</span>
									<span className="text-xs text-[#8a7d70]">{lastAuditLabel(item, locale)}</span>
								</button>
							);
						})}
					</nav>
					{projects.length === 0 && !showCreate && (
						<p className="rounded-xl border border-dashed border-[#d9cfc2] p-4 text-sm text-[#6e6258]">
							{tr(locale, "Create your first project to begin.", "Создайте первый проект, чтобы начать.")}
						</p>
					)}
				</aside>

				<div className="min-w-0 space-y-7">
					{showCreate && (
						<CreateProjectForm
							locale={locale}
							form={projectForm}
							pending={pendingAction === "project"}
							feedback={feedbackScope === "project" ? { notice, error } : undefined}
							onChange={setProjectForm}
							onSubmit={createProject}
							onCancel={projects.length > 0 ? () => setShowCreate(false) : undefined}
						/>
					)}

					{!showCreate && selectedProject && (
						<>
							<ProjectOverview project={selectedProject} locale={locale} />
							<SetupProgress project={selectedProject} locale={locale} />
							<BrandProfileForm
								locale={locale}
								project={selectedProject}
								form={profileForm}
								pending={pendingAction === "profile"}
								feedback={feedbackScope === "profile" ? { notice, error } : undefined}
								suggesting={suggesting}
								suggestion={suggestion}
								onChange={setProfileForm}
								onSubmit={saveProfile}
								onSuggest={suggestProfile}
								onApplySuggestion={(competitors, questions) => {
									setProfileForm((current) => ({
										...current,
										competitors: competitors.join(", "),
										scenarios: questions.join("\n"),
									}));
									setSuggestion(null);
									setNotice(
										tr(
											locale,
											"Accepted. Check the fields and confirm the profile.",
											"Принято. Проверьте поля и подтвердите профиль.",
										),
									);
								}}
							/>
							<WebsiteEvidence
								locale={locale}
								project={selectedProject}
								pending={pendingAction === "website"}
								feedback={feedbackScope === "website" ? { notice, error } : undefined}
								onCollect={collectWebsite}
							/>
							<QuestionsPanel project={selectedProject} locale={locale} />
							<MeasurementPanel project={selectedProject} locale={locale} />
							<ResultsPanel project={selectedProject} locale={locale} />
						</>
					)}
				</div>
			</main>
		</div>
	);
}

function ProjectOverview({ project, locale }: { project: WorkspaceProject; locale: WorkspaceLocale }) {
	return (
		<section className="selena-hero-panel">
			<div className="max-w-2xl">
				<p className="text-sm font-semibold text-[#d9aa86]">{project.project.category}</p>
				<h2 className="selena-heading mt-2 text-4xl text-[#fffdf8] sm:text-5xl">{project.project.name}</h2>
				<p className="mt-4 max-w-xl text-base leading-7 text-[#e9dfd4]">
					{project.project.region ? `${project.project.region}, ` : ""}
					{project.project.country} · {project.project.languages.map((language) => language.toUpperCase()).join(" + ")}
				</p>
			</div>
			<div className="mt-8 flex flex-wrap items-center gap-3 text-sm text-[#e9dfd4]">
				<span className="selena-status-chip">{projectStageLabel(project, locale)}</span>
				<span>{lastAuditLabel(project, locale)}</span>
				{project.measurement && (
					<span>
						{locale === "ru"
							? `Проверено ответов: ${project.measurement.completedRuns} из ${project.measurement.expectedRuns}`
							: `${project.measurement.completedRuns} of ${project.measurement.expectedRuns} answers checked`}
					</span>
				)}
			</div>
		</section>
	);
}

function SetupProgress({ project, locale }: { project: WorkspaceProject; locale: WorkspaceLocale }) {
	const steps = [
		{ label: tr(locale, "Project created", "Проект создан"), complete: true },
		{ label: tr(locale, "Brand profile confirmed", "Профиль бренда подтверждён"), complete: Boolean(project.profile) },
		{
			label: tr(locale, "Technical website check complete", "Техническая проверка сайта завершена"),
			complete: Boolean(project.website),
		},
		{
			label: tr(locale, "AI visibility report available", "Отчёт о видимости в AI готов"),
			complete: project.measurement?.status === "READY",
		},
	];
	return (
		<section aria-labelledby="setup-progress-title" className="selena-section">
			<div className="flex items-end justify-between gap-4">
				<div>
					<h2 id="setup-progress-title" className="selena-heading text-2xl">
						{tr(locale, "1 · Setup progress", "1 · Подготовка проекта")}
					</h2>
					<p className="mt-2 text-sm leading-6 text-[#6e6258]">
						{tr(
							locale,
							"Complete these steps to prepare the project and its AI visibility report.",
							"Выполните эти шаги, чтобы подготовить проект и отчёт о видимости в AI.",
						)}
					</p>
				</div>
				<span className="text-sm font-semibold text-[#8f5c34]">{steps.filter((step) => step.complete).length}/4</span>
			</div>
			<ol className="mt-6 grid gap-3 sm:grid-cols-2">
				{steps.map((step) => (
					<li key={step.label} className="flex min-h-14 items-center gap-3 border-t border-[#e6ddd1] pt-3 text-sm">
						{step.complete ? (
							<IconCheck className="size-5 shrink-0 text-[#2e7d4f]" aria-hidden="true" />
						) : (
							<IconCircleDashed className="size-5 shrink-0 text-[#8e8175]" aria-hidden="true" />
						)}
						<span className={step.complete ? "font-medium text-[#181614]" : "text-[#6e6258]"}>{step.label}</span>
					</li>
				))}
			</ol>
		</section>
	);
}

function CreateProjectForm({
	locale,
	form,
	pending,
	feedback,
	onChange,
	onSubmit,
	onCancel,
}: {
	locale: WorkspaceLocale;
	form: typeof emptyProjectForm;
	pending: boolean;
	feedback?: Feedback;
	onChange: (value: typeof emptyProjectForm) => void;
	onSubmit: (event: React.FormEvent) => void;
	onCancel?: () => void;
}) {
	return (
		<section className="selena-section">
			<h2 className="selena-heading text-3xl">{tr(locale, "Create a project", "Создать проект")}</h2>
			<p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">
				{tr(
					locale,
					"Start with the business and market you want to understand. Creating a project does not start a paid scan.",
					"Укажите бизнес и рынок, который хотите изучить. Создание проекта не запускает платную проверку.",
				)}
			</p>
			<form onSubmit={onSubmit} className="mt-7 grid gap-5 sm:grid-cols-2">
				<Field label={tr(locale, "Project name", "Название проекта")} htmlFor="project-name">
					<Input
						id="project-name"
						required
						value={form.name}
						onChange={(event) => onChange({ ...form, name: event.target.value })}
						placeholder="Usha Bakery"
					/>
				</Field>
				<Field label={tr(locale, "Business category", "Категория бизнеса")} htmlFor="project-category">
					<Input
						id="project-category"
						required
						value={form.category}
						onChange={(event) => onChange({ ...form, category: event.target.value })}
						placeholder="Cafe and restaurant"
					/>
				</Field>
				<Field
					label={tr(locale, "Country code", "Код страны")}
					hint={tr(locale, "Two letters, for example ID or US", "Две буквы, например ID или US")}
					htmlFor="project-country"
				>
					<Input
						id="project-country"
						required
						minLength={2}
						maxLength={2}
						value={form.country}
						onChange={(event) => onChange({ ...form, country: event.target.value.toUpperCase() })}
					/>
				</Field>
				<Field label={tr(locale, "City or region", "Город или регион")} htmlFor="project-region">
					<Input
						id="project-region"
						value={form.region}
						onChange={(event) => onChange({ ...form, region: event.target.value })}
						placeholder="Ubud"
					/>
				</Field>
				<Field
					label={tr(locale, "Languages", "Языки")}
					hint={tr(locale, "Comma separated, for example en, ru", "Через запятую, например en, ru")}
					htmlFor="project-languages"
				>
					<Input
						id="project-languages"
						required
						value={form.languages}
						onChange={(event) => onChange({ ...form, languages: event.target.value.toLowerCase() })}
					/>
				</Field>
				<FormFeedback feedback={feedback} className="sm:col-span-2" />
				<div className="flex items-end gap-3">
					<Button type="submit" className="selena-primary-button min-h-11" disabled={pending}>
						{pending ? tr(locale, "Creating…", "Создаём…") : tr(locale, "Create project", "Создать проект")}{" "}
						<IconArrowRight className="size-4" />
					</Button>
					{onCancel && (
						<Button type="button" variant="ghost" className="min-h-11" onClick={onCancel}>
							{tr(locale, "Cancel", "Отмена")}
						</Button>
					)}
				</div>
			</form>
		</section>
	);
}

/**
 * The suggested competitors and questions, each behind a checkbox — accepting
 * the selection is the customer's judgement, so nothing lands in the fields
 * without their tick.
 */
function SuggestionPicker({
	locale,
	suggestion,
	onApply,
}: {
	locale: WorkspaceLocale;
	suggestion: { competitors: string[]; questions: string[] };
	onApply: (competitors: string[], questions: string[]) => void;
}) {
	const [checkedCompetitors, setCheckedCompetitors] = useState<Set<string>>(new Set(suggestion.competitors));
	const [checkedQuestions, setCheckedQuestions] = useState<Set<string>>(new Set(suggestion.questions));

	useEffect(() => {
		setCheckedCompetitors(new Set(suggestion.competitors));
		setCheckedQuestions(new Set(suggestion.questions));
	}, [suggestion]);

	const toggle = (set: Set<string>, update: (next: Set<string>) => void, value: string) => {
		const next = new Set(set);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		update(next);
	};

	const group = (
		title: string,
		items: string[],
		checked: Set<string>,
		update: (next: Set<string>) => void,
		prefix: string,
	) =>
		items.length > 0 && (
			<div>
				<p className="text-xs font-semibold uppercase tracking-wide text-[#6e6258]">{title}</p>
				<ul className="mt-2 grid gap-1.5">
					{items.map((item) => (
						<li key={item} className="flex items-start gap-2.5">
							<Checkbox
								id={`${prefix}-${item}`}
								checked={checked.has(item)}
								onCheckedChange={() => toggle(checked, update, item)}
								className="mt-0.5"
							/>
							<label htmlFor={`${prefix}-${item}`} className="cursor-pointer text-sm leading-6">
								{item}
							</label>
						</li>
					))}
				</ul>
			</div>
		);

	return (
		<div className="grid gap-4 border-t border-[#e6ddd1] pt-4">
			{group(
				tr(locale, "Suggested competitors", "Предложенные конкуренты"),
				suggestion.competitors,
				checkedCompetitors,
				setCheckedCompetitors,
				"sc",
			)}
			{group(
				tr(locale, "Suggested questions", "Предложенные вопросы"),
				suggestion.questions,
				checkedQuestions,
				setCheckedQuestions,
				"sq",
			)}
			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					size="sm"
					disabled={checkedCompetitors.size + checkedQuestions.size === 0}
					onClick={() =>
						onApply(
							suggestion.competitors.filter((item) => checkedCompetitors.has(item)),
							suggestion.questions.filter((item) => checkedQuestions.has(item)),
						)
					}
				>
					{tr(
						locale,
						`Accept checked (${checkedCompetitors.size + checkedQuestions.size})`,
						`Принять отмеченные (${checkedCompetitors.size + checkedQuestions.size})`,
					)}
				</Button>
				<span className="text-xs text-[#6e6258]">
					{tr(
						locale,
						"They will fill the Competitors and Customer questions fields below.",
						"Они заполнят поля «Конкуренты» и «Вопросы клиентов» ниже.",
					)}
				</span>
			</div>
		</div>
	);
}

function BrandProfileForm({
	locale,
	project,
	form,
	pending,
	feedback,
	suggesting,
	suggestion,
	onChange,
	onSubmit,
	onSuggest,
	onApplySuggestion,
}: {
	locale: WorkspaceLocale;
	project: WorkspaceProject;
	form: typeof emptyProfileForm;
	pending: boolean;
	feedback?: Feedback;
	suggesting: boolean;
	suggestion: { competitors: string[]; questions: string[] } | null;
	onChange: (value: typeof emptyProfileForm) => void;
	onSubmit: (event: React.FormEvent) => void;
	onSuggest: () => void;
	onApplySuggestion: (competitors: string[], questions: string[]) => void;
}) {
	return (
		<section className="selena-section" aria-labelledby="brand-profile-title">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h2 id="brand-profile-title" className="selena-heading text-2xl">
						{tr(locale, "2 · Brand profile", "2 · Профиль бренда")}
					</h2>
					<p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">
						{tr(
							locale,
							"Confirm the public information and the questions customers ask. AI visibility checks start only after you approve a plan.",
							"Подтвердите публичную информацию и вопросы клиентов. Проверка видимости в AI начнётся только после выбора плана.",
						)}
					</p>
				</div>
				{project.profile && (
					<span className="selena-success-label">
						<IconCheck className="size-4" /> {tr(locale, "Saved", "Сохранено")}
					</span>
				)}
			</div>
			<form onSubmit={onSubmit} className="mt-7 grid gap-5 sm:grid-cols-2">
				<Field label={tr(locale, "Public brand name", "Публичное название бренда")} htmlFor="brand-name">
					<Input
						id="brand-name"
						required
						value={form.brandName}
						onChange={(event) => onChange({ ...form, brandName: event.target.value })}
						placeholder={project.project.name}
					/>
				</Field>
				<Field label={tr(locale, "Primary website", "Основной сайт")} htmlFor="primary-domain">
					<Input
						id="primary-domain"
						required
						inputMode="url"
						autoComplete="url"
						autoCapitalize="none"
						spellCheck={false}
						value={form.primaryDomain}
						onChange={(event) => onChange({ ...form, primaryDomain: event.target.value })}
						placeholder="example.com"
					/>
				</Field>
				<Field
					label={tr(locale, "Google Maps location", "Локация в Google Maps")}
					hint={tr(
						locale,
						"Optional. Your place's share link — it pins the exact business for local questions",
						"Необязательно. Ссылка «Поделиться» вашей точки — она однозначно указывает бизнес в локальных вопросах",
					)}
					htmlFor="maps-location"
				>
					<Input
						id="maps-location"
						inputMode="url"
						autoCapitalize="none"
						spellCheck={false}
						value={form.mapsLocation}
						onChange={(event) => onChange({ ...form, mapsLocation: event.target.value })}
						placeholder="https://maps.app.goo.gl/…"
					/>
				</Field>
				<Field
					label={tr(locale, "Public profile links", "Ссылки на публичные профили")}
					hint={tr(
						locale,
						"Optional. Instagram, TripAdvisor — comma separated",
						"Необязательно. Instagram, TripAdvisor — через запятую",
					)}
					htmlFor="public-profiles"
				>
					<Input
						id="public-profiles"
						inputMode="url"
						autoCapitalize="none"
						spellCheck={false}
						value={form.publicProfiles}
						onChange={(event) => onChange({ ...form, publicProfiles: event.target.value })}
						placeholder={tr(locale, "Instagram or other public profile", "Instagram или другой публичный профиль")}
					/>
				</Field>
				<div className="flex flex-col gap-3 rounded-xl border border-[#e6ddd1] bg-[#fbf7f1] p-4 sm:col-span-2">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<p className="text-sm leading-6 text-[#6e6258]">
							{locale === "ru"
								? `Не уверены, кого писать в конкурентах и какие вопросы задать? Мы прочитаем сайт выше и предложим до ${SUGGESTION_LIMITS.competitors} конкурентов и ${SUGGESTION_LIMITS.questions} вопросов — вы отметите галочками, что оставить.`
								: `Not sure who to list or what to ask? We read the website above and propose up to ${SUGGESTION_LIMITS.competitors} competitors and ${SUGGESTION_LIMITS.questions} questions — you tick what stays.`}
						</p>
						<Button
							type="button"
							variant="outline"
							className="min-h-11 shrink-0 border-[#cdbdac] bg-[#fffdf8]"
							disabled={suggesting || pending}
							onClick={onSuggest}
						>
							<IconRefresh className={suggesting ? "size-4 animate-spin" : "hidden"} />
							<IconSparkles className={suggesting ? "hidden" : "size-4"} />
							{suggesting
								? tr(locale, "Reading the site…", "Читаем сайт…")
								: tr(locale, "Suggest automatically", "Подобрать автоматически")}
						</Button>
					</div>
					{suggesting && (
						<div aria-live="polite">
							<p className="text-xs text-[#8f5c34]">
								{tr(
									locale,
									"Working: reading the pages and drafting the lists — usually about a minute. Do not leave the page.",
									"Идёт работа: читаем страницы и готовим списки — обычно около минуты. Не уходите со страницы.",
								)}
							</p>
							<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#ece4d7]">
								<div className="selena-progress-strip h-full w-1/3 rounded-full bg-[#b9825b]" />
							</div>
						</div>
					)}
					{suggestion && !suggesting && (
						<SuggestionPicker locale={locale} suggestion={suggestion} onApply={onApplySuggestion} />
					)}
				</div>
				<Field
					label={tr(locale, "Competitors", "Конкуренты")}
					hint={tr(locale, "Comma separated", "Через запятую")}
					htmlFor="competitors"
				>
					<Input
						id="competitors"
						value={form.competitors}
						onChange={(event) => onChange({ ...form, competitors: event.target.value })}
						placeholder="Competitor One, Competitor Two"
					/>
				</Field>
				<div className="sm:col-span-2">
					<Field
						label={tr(locale, "Customer questions", "Вопросы клиентов")}
						hint={tr(
							locale,
							"One per line. Add EN: or RU: to specify the language. Leave it empty — questions are suggested when you confirm.",
							"Один вопрос в строке. Добавьте EN: или RU:, чтобы указать язык. Оставьте пустым — вопросы подберутся сами при подтверждении.",
						)}
						htmlFor="scenarios"
					>
						<textarea
							id="scenarios"
							className="selena-textarea"
							value={form.scenarios}
							onChange={(event) => onChange({ ...form, scenarios: event.target.value })}
							placeholder={
								"EN: we're in ubud for a week — where do we get breakfast with good coffee?\nRU: мы в Убуде на неделю — где вкусно позавтракать?"
							}
						/>
					</Field>
				</div>
				<FormFeedback feedback={feedback} className="sm:col-span-2" />
				<div className="sm:col-span-2">
					<Button type="submit" className="selena-primary-button min-h-11" disabled={pending}>
						{pending
							? tr(locale, "Saving…", "Сохраняем…")
							: project.profile
								? tr(locale, "Save changes", "Сохранить изменения")
								: tr(locale, "Confirm brand profile", "Подтвердить профиль бренда")}
					</Button>
				</div>
			</form>
		</section>
	);
}

function WebsiteEvidence({
	locale,
	project,
	pending,
	feedback,
	onCollect,
}: {
	locale: WorkspaceLocale;
	project: WorkspaceProject;
	pending: boolean;
	feedback?: Feedback;
	onCollect: () => void;
}) {
	return (
		<section className="selena-section" aria-labelledby="website-evidence-title">
			<div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex gap-4">
					<div className="selena-icon-disc">
						<IconGlobe className="size-5" />
					</div>
					<div>
						<h2 id="website-evidence-title" className="selena-heading text-2xl">
							{tr(locale, "3 · Technical website check", "3 · Техническая проверка сайта")}
						</h2>
						{project.website ? (
							<p className="mt-2 text-sm leading-6 text-[#6e6258]">
								{tr(locale, "Last reviewed", "Последняя проверка")} {formatDate(project.website.capturedAt, locale)} ·{" "}
								{project.website.website}
							</p>
						) : (
							<p className="mt-2 text-sm leading-6 text-[#6e6258]">
								{tr(
									locale,
									"How technically ready the site is for AI agents to read: crawling, structure, markup. This is not a visibility measurement.",
									"Насколько сайт технически готов к чтению AI-агентами: краулинг, структура, разметка. Это не замер видимости.",
								)}
							</p>
						)}
					</div>
				</div>
				<Button
					type="button"
					variant="outline"
					className="min-h-11 shrink-0 border-[#cdbdac] bg-[#fffdf8]"
					disabled={!project.profile || pending}
					onClick={onCollect}
				>
					<IconRefresh className={pending ? "size-4 animate-spin" : "size-4"} />
					{pending
						? tr(locale, "Reviewing…", "Проверяем…")
						: project.website
							? tr(locale, "Review again", "Проверить снова")
							: tr(locale, "Review website", "Проверить сайт")}
				</Button>
			</div>
			{!project.profile && (
				<p className="mt-4 text-sm text-[#9a5f14]">
					{tr(
						locale,
						"Save the brand profile before reviewing the website.",
						"Сохраните профиль бренда перед проверкой сайта.",
					)}
				</p>
			)}
			<FormFeedback feedback={feedback} className="mt-5" />
		</section>
	);
}

/**
 * Step 2 of the cabinet: approving the questions a paid cycle will ask. The
 * backend has always refused to order unapproved scenarios; this screen makes
 * that decision the customer's. Text can be edited only as part of the
 * decision — the same single repository path the operator desk uses.
 */
function QuestionsPanel({ project, locale }: { project: WorkspaceProject; locale: WorkspaceLocale }) {
	const [scenarios, setScenarios] = useState<ScenarioListItem[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	// Checked by default: the customer unchecks what they disagree with, then
	// approves the selection in one action — the HubSpot-copy flow's one
	// deliberate extra step.
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [bulkBusy, setBulkBusy] = useState(false);
	const [busyId, setBusyId] = useState("");
	const [rowError, setRowError] = useState("");

	const load = () => {
		getSelenaScenariosListFn({ data: { projectId: project.project.id } })
			.then((data) => setScenarios(data.scenarios))
			.catch(() => setFailed(true));
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the project changes
	useEffect(load, [project.project.id]);

	useEffect(() => {
		setChecked(new Set((scenarios ?? []).filter((item) => item.status === "PROPOSED").map((item) => item.id)));
	}, [scenarios]);

	const decideChecked = async (decision: "APPROVED" | "REJECTED") => {
		const targets = proposed.filter((scenario) => checked.has(scenario.id));
		if (targets.length === 0) return;
		setBulkBusy(true);
		setRowError("");
		try {
			for (const scenario of targets) {
				const draft = drafts[scenario.id];
				await reviewSelenaScenarioFn({
					data: {
						scenarioId: scenario.id,
						decision,
						...(draft !== undefined && draft !== scenario.text ? { text: draft } : {}),
					},
				});
			}
			load();
		} catch (cause) {
			setRowError(
				humanizeSelenaError(
					cause,
					locale,
					tr(locale, "Could not save the decision. Try again.", "Не удалось сохранить решение. Попробуйте ещё раз."),
				),
			);
		} finally {
			setBulkBusy(false);
		}
	};

	const proposed = scenarios?.filter((item) => item.status === "PROPOSED") ?? [];
	const decided = scenarios?.filter((item) => item.status !== "PROPOSED") ?? [];

	return (
		<section className="selena-section" aria-labelledby="questions-title">
			<div className="flex gap-4">
				<div className="selena-icon-disc">
					<IconCheck className="size-5" />
				</div>
				<div>
					<h2 id="questions-title" className="selena-heading text-2xl">
						{tr(locale, "4 · Approve the questions", "4 · Утвердите вопросы")}
					</h2>
					<p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">
						{tr(
							locale,
							"A paid measurement asks only questions you approved. Edit the wording if needed, then approve or reject each one — nothing runs on unapproved questions.",
							"Платный замер задаёт только утверждённые вами вопросы. Поправьте формулировку, если нужно, и утвердите или отклоните каждый — по неутверждённым вопросам ничего не запускается.",
						)}
					</p>
				</div>
			</div>
			{project.profile?.confirmedAt && (
				<div className="mt-4">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="border-[#cdbdac] bg-[#fffdf8]"
						disabled={busyId === "prepare"}
						onClick={async () => {
							setBusyId("prepare");
							setRowError("");
							try {
								await prepareSelenaScenariosFn({ data: { projectId: project.project.id } });
								load();
							} catch (cause) {
								setRowError(
									humanizeSelenaError(
										cause,
										locale,
										tr(
											locale,
											"Could not prepare the questions. Try again.",
											"Не удалось подготовить вопросы. Попробуйте ещё раз.",
										),
									),
								);
							} finally {
								setBusyId("");
							}
						}}
					>
						{busyId === "prepare"
							? tr(locale, "Preparing…", "Готовим…")
							: tr(locale, "Suggest questions from my profile", "Подобрать вопросы из профиля")}
					</Button>
					{rowError && <p className="mt-2 text-sm text-[#9a5f14]">{rowError}</p>}
				</div>
			)}
			{failed ? (
				<p className="mt-5 text-sm text-[#9a5f14]">
					{tr(locale, "Could not load the questions.", "Не удалось загрузить вопросы.")}
				</p>
			) : scenarios === null ? (
				<p className="mt-5 text-sm text-[#6e6258]">{tr(locale, "Loading…", "Загружаем…")}</p>
			) : scenarios.length === 0 ? (
				<p className="mt-5 rounded-lg border border-dashed border-[#cdbdac] bg-[#fffdf8] px-4 py-3 text-sm text-[#6e6258]">
					{tr(
						locale,
						"No questions proposed yet. They appear here after the profile is confirmed and questions are prepared.",
						"Вопросов пока не предложено. Они появятся здесь после подтверждения профиля и подготовки вопросов.",
					)}
				</p>
			) : (
				<div className="mt-5 flex flex-col gap-3">
					{proposed.map((scenario) => (
						<div
							key={scenario.id}
							className="flex items-start gap-3 rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4"
						>
							<Checkbox
								id={`question-${scenario.id}`}
								checked={checked.has(scenario.id)}
								onCheckedChange={() =>
									setChecked((current) => {
										const next = new Set(current);
										if (next.has(scenario.id)) next.delete(scenario.id);
										else next.add(scenario.id);
										return next;
									})
								}
								className="mt-1"
							/>
							<div className="min-w-0 flex-1">
								<label htmlFor={`question-${scenario.id}`} className="text-xs uppercase tracking-wide text-[#6e6258]">
									{scenario.language.toUpperCase()} ·{" "}
									{scenario.intentType === "branded"
										? tr(locale, "names the brand", "с названием бренда")
										: tr(locale, "category question", "вопрос про категорию")}
								</label>
								{/* Customer-style questions run to ~20 words; a one-line input
								    would hide the tail of the very text being approved. */}
								<textarea
									rows={2}
									className="selena-textarea mt-2"
									value={drafts[scenario.id] ?? scenario.text}
									onChange={(event) => setDrafts((current) => ({ ...current, [scenario.id]: event.target.value }))}
								/>
							</div>
						</div>
					))}
					{proposed.length > 0 && (
						<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e5dbcd] bg-[#fffdf8] px-4 py-3">
							<p className="text-sm text-[#3d362e]">
								{tr(
									locale,
									`${checked.size} of ${proposed.length} question(s) checked`,
									`Отмечено вопросов: ${checked.size} из ${proposed.length}`,
								)}
							</p>
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									disabled={checked.size === 0 || bulkBusy}
									onClick={() => void decideChecked("APPROVED")}
								>
									{bulkBusy
										? tr(locale, "Saving…", "Сохраняем…")
										: tr(locale, "Approve checked", "Утвердить отмеченные")}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={checked.size === 0 || bulkBusy}
									onClick={() => void decideChecked("REJECTED")}
								>
									{tr(locale, "Reject checked", "Отклонить отмеченные")}
								</Button>
							</div>
						</div>
					)}
					{decided.length > 0 && (
						<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4">
							<h3 className="text-sm font-semibold text-[#3d362e]">{tr(locale, "Decided", "Решённые")}</h3>
							<ul className="mt-2 flex flex-col gap-1 text-sm text-[#3d362e]">
								{decided.map((scenario) => (
									<li key={scenario.id} className="flex items-start justify-between gap-3">
										<span>{scenario.text}</span>
										<span className="shrink-0 text-xs text-[#6e6258]">
											{scenario.status === "APPROVED"
												? tr(locale, "approved", "утверждён")
												: tr(locale, "rejected", "отклонён")}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

/**
 * Step 4 of the cabinet: the paid measurement. Locked (shown, not hidden)
 * until the project has a cycle; once one exists, renders the ledger report
 * with branded and non-branded apart, UNKNOWN for an empty group, and no
 * composite score anywhere — the CABINET_MODEL rules the backend already
 * enforces, made visible.
 */
function MeasurementPanel({ project, locale }: { project: WorkspaceProject; locale: WorkspaceLocale }) {
	const [view, setView] = useState<MeasurementView | null>(null);
	const [failed, setFailed] = useState(false);
	const hasCycle = project.measurement !== null;

	useEffect(() => {
		if (!hasCycle) return;
		let cancelled = false;
		getSelenaMeasurementFn({ data: { projectId: project.project.id } })
			.then((data) => {
				if (!cancelled) setView(data);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [hasCycle, project.project.id]);

	return (
		<section className="selena-section" aria-labelledby="measurement-title">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex gap-4">
					<div className="selena-icon-disc">
						<IconSparkles className="size-5" />
					</div>
					<div>
						<h2 id="measurement-title" className="selena-heading text-2xl">
							{tr(locale, "5 · Measurement", "5 · Замер")}
						</h2>
						<p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">
							{tr(
								locale,
								"What the ordered AI measurement observed. Questions naming the brand and category questions are counted separately and never merged into one score.",
								"Что показал заказанный AI-замер. Вопросы с названием бренда и вопросы про категорию считаются раздельно и никогда не сводятся в один балл.",
							)}
						</p>
					</div>
				</div>
				{hasCycle && (
					<Link to="/app/selena-report" search={{ project: project.project.id }} className="shrink-0">
						<Button type="button" variant="outline" className="border-[#cdbdac] bg-[#fffdf8]">
							{tr(locale, "Open the full report", "Открыть полный отчёт")}
						</Button>
					</Link>
				)}
			</div>
			{!hasCycle ? (
				<p className="mt-5 rounded-lg border border-dashed border-[#cdbdac] bg-[#fffdf8] px-4 py-3 text-sm text-[#6e6258]">
					{tr(
						locale,
						"This step opens after a measurement order is confirmed. No cycle has been ordered yet.",
						"Этот шаг откроется после подтверждения заказа на замер. Цикл ещё не заказан.",
					)}
				</p>
			) : failed ? (
				<p className="mt-5 text-sm text-[#9a5f14]">
					{tr(locale, "Could not load the measurement.", "Не удалось загрузить замер.")}
				</p>
			) : view === null ? (
				<p className="mt-5 text-sm text-[#6e6258]">{tr(locale, "Loading…", "Загружаем…")}</p>
			) : (
				<MeasurementReport view={view} locale={locale} projectId={project.project.id} />
			)}
		</section>
	);
}

function MeasurementReport({
	view,
	locale,
	projectId,
}: {
	view: MeasurementView;
	locale: WorkspaceLocale;
	projectId: string;
}) {
	const latest = view.latest;
	const cycle = view.cycles[0];
	if (!latest || !cycle) {
		return (
			<p className="mt-5 text-sm text-[#6e6258]">
				{tr(locale, "No measurement cycle recorded yet.", "Ни одного цикла замера ещё не записано.")}
			</p>
		);
	}
	const statusLabel: Record<string, [string, string]> = {
		SCHEDULED: ["Scheduled", "Запланирован"],
		RUNNING: ["Running", "Выполняется"],
		QC_REQUIRED: ["Awaiting quality review", "Ожидает проверку качества"],
		READY: ["Ready", "Готов"],
		DELIVERED: ["Delivered", "Выдан"],
	};
	const [en, ru] = statusLabel[cycle.status] ?? [cycle.status, cycle.status];
	return (
		<div className="mt-5 flex flex-col gap-4">
			<p className="text-sm text-[#6e6258]">
				{tr(locale, "Cycle status", "Статус цикла")}: <strong>{tr(locale, en, ru)}</strong> ·{" "}
				{tr(locale, "runs completed", "прогонов завершено")}: {cycle.completedRuns} / {cycle.expectedRuns}
			</p>
			<div className="grid gap-4 sm:grid-cols-2">
				<MeasurementGroup
					locale={locale}
					title={tr(locale, "Category questions (no brand name)", "Вопросы про категорию (без названия бренда)")}
					group={groupView(latest.report.nonBranded)}
				/>
				<MeasurementGroup
					locale={locale}
					title={tr(locale, "Questions naming the brand", "Вопросы с названием бренда")}
					group={groupView(latest.report.branded)}
				/>
			</div>
			<RelativeMentionShare locale={locale} report={latest.report} />
			<VisitorApiSplit locale={locale} report={latest.report} />
			{latest.report.unclassifiedRuns > 0 && (
				<p className="text-xs text-[#6e6258]">
					{tr(locale, "Runs outside both groups", "Прогоны вне обеих групп")}: {latest.report.unclassifiedRuns}
				</p>
			)}
			<RunExplorer cycleId={latest.cycleId} locale={locale} />
			<CycleComparePanel cycleCount={view.cycles.length} locale={locale} projectId={projectId} />
		</div>
	);
}

/**
 * Step 7: what changed between the two newest cycles — and in which measured
 * answers. Deliberately never "thanks to us": engines and competitors change
 * over the same weeks, and the diff states observations, not causes.
 */
function CycleComparePanel({
	cycleCount,
	locale,
	projectId,
}: {
	cycleCount: number;
	locale: WorkspaceLocale;
	projectId: string;
}) {
	const [result, setResult] = useState<CycleCompareResult | null>(null);

	useEffect(() => {
		if (cycleCount < 2 || !projectId) return;
		let cancelled = false;
		getSelenaCycleCompareFn({ data: { projectId } })
			.then((data) => {
				if (!cancelled) setResult(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cycleCount, projectId]);

	if (cycleCount < 2)
		return (
			<p className="rounded-lg border border-dashed border-[#cdbdac] bg-[#fffdf8] px-4 py-3 text-sm text-[#6e6258]">
				{tr(
					locale,
					"Comparison between measurements opens after the second cycle.",
					"Сравнение между замерами откроется после второго цикла.",
				)}
			</p>
		);
	if (!result || !result.comparable) return null;

	const label = (change: CycleDiffChange): string => {
		switch (change.type) {
			case "MENTION_APPEARED":
				return tr(locale, "the brand is now mentioned", "бренд теперь упоминается");
			case "MENTION_DISAPPEARED":
				return tr(locale, "the brand is no longer mentioned", "бренд больше не упоминается");
			case "POSITION_SHIFTED":
				return `${tr(locale, "position", "позиция")} ${change.basePosition} → ${change.comparePosition}`;
			case "SOURCE_APPEARED":
				return `${tr(locale, "new cited source", "новый цитируемый источник")}: ${change.domain}`;
			case "SOURCE_DISAPPEARED":
				return `${tr(locale, "source no longer cited", "источник больше не цитируется")}: ${change.domain}`;
		}
	};

	const unknownGroups = result.report.groups.filter((group) => group.status === "UNKNOWN");
	return (
		<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4">
			<h3 className="text-sm font-semibold text-[#3d362e]">
				{tr(locale, "What changed between the measurements", "Что изменилось между замерами")}
			</h3>
			<p className="mt-1 text-xs text-[#6e6258]">
				{tr(
					locale,
					"Observed differences only — engines and competitors also change over the same period.",
					"Только наблюдаемые различия — за то же время меняются и движки, и конкуренты.",
				)}
			</p>
			{result.report.changes.length === 0 ? (
				<p className="mt-2 text-sm text-[#6e6258]">
					{tr(locale, "No differences in the compared groups.", "В сравнимых группах различий нет.")}
				</p>
			) : (
				<ul className="mt-2 flex flex-col gap-1 text-sm text-[#3d362e]">
					{result.report.changes.map((change, index) => (
						<li key={`${change.type}-${change.scenarioId}-${change.system}-${index}`}>
							{change.system} · {label(change)}{" "}
							<span className="text-xs text-[#6e6258]">
								({tr(locale, "measured in", "измерено в")} {change.evidence.baseRunIds.length}+
								{change.evidence.compareRunIds.length} {tr(locale, "answers", "ответах")})
							</span>
						</li>
					))}
				</ul>
			)}
			{unknownGroups.length > 0 && (
				<p className="mt-2 text-xs text-[#6e6258]">
					{tr(locale, "Groups not comparable between the cycles", "Группы, несравнимые между циклами")}:{" "}
					{unknownGroups.length}
				</p>
			)}
		</div>
	);
}

/**
 * Addendum §7 made visible: each answer behind the numbers, with the verbatim
 * text while it is inside its retention window and an honest marker after.
 */
function RunExplorer({ cycleId, locale }: { cycleId: string; locale: WorkspaceLocale }) {
	const [runs, setRuns] = useState<RunListItem[] | null>(null);
	const [openRunId, setOpenRunId] = useState("");
	const [detail, setDetail] = useState<RunDetail | null>(null);

	useEffect(() => {
		let cancelled = false;
		listSelenaRunsFn({ data: { cycleId } })
			.then((data) => {
				if (!cancelled) setRuns(data.runs);
			})
			.catch(() => {
				if (!cancelled) setRuns([]);
			});
		return () => {
			cancelled = true;
		};
	}, [cycleId]);

	const openRun = async (runId: string) => {
		if (openRunId === runId) {
			setOpenRunId("");
			setDetail(null);
			return;
		}
		setOpenRunId(runId);
		setDetail(null);
		try {
			setDetail(await getSelenaRunDetailFn({ data: { runId } }));
		} catch {
			setOpenRunId("");
		}
	};

	if (!runs || runs.length === 0) return null;
	return (
		<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4">
			<h3 className="text-sm font-semibold text-[#3d362e]">
				{tr(locale, "Answers behind the numbers", "Ответы, из которых собраны цифры")}
			</h3>
			<ul className="mt-2 flex flex-col gap-1">
				{runs.map((run) => (
					<li key={run.id}>
						<button
							type="button"
							className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-[#f5eee2]"
							onClick={() => openRun(run.id)}
						>
							<span className="text-[#3d362e]">
								{run.system ?? "—"} ·{" "}
								{run.channel === "VISITOR" || run.channel.toLowerCase().startsWith("visitor")
									? "Visitor View"
									: "API View"}
							</span>
							<span className="shrink-0 text-xs text-[#6e6258]">
								{run.validity ?? run.status}
								{run.finishedAt ? ` · ${formatDate(run.finishedAt, locale)}` : ""}
							</span>
						</button>
						{openRunId === run.id && (
							<div className="mt-1 rounded border border-[#e5dbcd] bg-white p-3 text-sm">
								{detail === null ? (
									<p className="text-[#6e6258]">{tr(locale, "Loading…", "Загружаем…")}</p>
								) : (
									<div className="flex flex-col gap-2">
										{detail.scenarioText && (
											<p>
												<span className="text-[#6e6258]">{tr(locale, "Question", "Вопрос")}: </span>
												{detail.scenarioText}
											</p>
										)}
										{detail.mentions.length > 0 ? (
											<p>
												<span className="text-[#6e6258]">{tr(locale, "Named", "Названы")}: </span>
												{detail.mentions
													.map((m) => `${m.name}${m.ordinalPosition ? ` (#${m.ordinalPosition})` : ""}`)
													.join(", ")}
											</p>
										) : (
											<p className="text-[#6e6258]">
												{tr(
													locale,
													"No tracked entity was named, or the answer is stored but not measured.",
													"Ни одна отслеживаемая сущность не названа, либо ответ сохранён, но не измерен.",
												)}
											</p>
										)}
										{detail.citations.length > 0 && (
											<p>
												<span className="text-[#6e6258]">{tr(locale, "Cited", "Процитированы")}: </span>
												{detail.citations.map((c) => c.domain).join(", ")}
											</p>
										)}
										{detail.sources.length > 0 && (
											<p>
												<span className="text-[#6e6258]">
													{tr(locale, "Shown as sources", "Показаны как источники")}:{" "}
												</span>
												{detail.sources.map((s) => s.domain).join(", ")}
											</p>
										)}
										{detail.answer.state === "present" ? (
											<blockquote className="whitespace-pre-wrap rounded bg-[#faf6ee] p-2 text-[#3d362e]">
												{detail.answer.text}
											</blockquote>
										) : detail.answer.state === "deleted" ? (
											<p className="text-[#6e6258]">
												{tr(
													locale,
													"The verbatim text was deleted at the end of its retention window; the findings above remain.",
													"Дословный текст удалён по окончании срока хранения; находки выше сохранены.",
												)}
											</p>
										) : null}
										{detail.rawResponseReference && (
											<p className="text-xs text-[#6e6258]">
												{tr(locale, "Answer reference", "Ссылка на ответ")}: {detail.rawResponseReference}
											</p>
										)}
									</div>
								)}
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

function MeasurementGroup({ locale, title, group }: { locale: WorkspaceLocale; title: string; group: GroupView }) {
	return (
		<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4">
			<h3 className="text-sm font-semibold text-[#3d362e]">{title}</h3>
			{group.state === "unknown" ? (
				<p className="mt-2 text-sm text-[#6e6258]">
					{tr(
						locale,
						"Unknown — no measured answers in this group yet. Not shown as 0%.",
						"Неизвестно — в этой группе пока нет измеренных ответов. Это не 0%.",
					)}
				</p>
			) : (
				<dl className="mt-2 grid gap-1 text-sm text-[#3d362e]">
					<div className="flex justify-between gap-3">
						<dt className="text-[#6e6258]">
							{tr(locale, "Answers mentioning the brand", "Ответы с упоминанием бренда")}
						</dt>
						<dd>{group.mentionCoverage ?? tr(locale, "unknown", "неизвестно")}</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-[#6e6258]">
							{tr(locale, "Average position among mentions", "Средняя позиция среди упоминаний")}
						</dt>
						<dd>{group.averageBrandPosition ?? "—"}</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-[#6e6258]">{tr(locale, "Measured answers", "Измеренных ответов")}</dt>
						<dd>{group.measuredRuns}</dd>
					</div>
					{group.unmeasuredRuns > 0 && (
						<div className="flex justify-between gap-3">
							<dt className="text-[#6e6258]">{tr(locale, "Stored but not measured", "Сохранено, но не измерено")}</dt>
							<dd>{group.unmeasuredRuns}</dd>
						</div>
					)}
				</dl>
			)}
		</div>
	);
}

/**
 * The Share-of-Voice analog on ledger evidence (addendum §6.2): the brand's
 * share among tracked-entity mentions, next to each confirmed competitor.
 * Rendered under the mixed label because it pools branded and non-branded —
 * the two group cards above stay the primary reading.
 */
function RelativeMentionShare({ locale, report }: { locale: WorkspaceLocale; report: LedgerReport }) {
	const mixed = report.mixed.group;
	if (mixed.status !== "MEASURED") return null;
	const share = mixed.metrics.relativeMentionShare;
	if (share.brand === null && share.competitors.length === 0) return null;
	return (
		<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4 text-sm">
			<h3 className="font-semibold text-[#3d362e]">
				{tr(
					locale,
					"Share among tracked mentions (both groups pooled)",
					"Доля среди отслеживаемых упоминаний (обе группы вместе)",
				)}
			</h3>
			<dl className="mt-2 grid gap-1 text-[#3d362e]">
				<div className="flex justify-between gap-3">
					<dt className="text-[#6e6258]">{tr(locale, "Your brand", "Ваш бренд")}</dt>
					<dd>{formatShare(share.brand) ?? tr(locale, "unknown", "неизвестно")}</dd>
				</div>
				{share.competitors.map((competitor) => (
					<div key={competitor.name} className="flex justify-between gap-3">
						<dt className="text-[#6e6258]">{competitor.name}</dt>
						<dd>{formatShare(competitor.share)}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

function VisitorApiSplit({ locale, report }: { locale: WorkspaceLocale; report: LedgerReport }) {
	const mixed = report.mixed.group;
	if (mixed.status !== "MEASURED") return null;
	const { visitorMentionRate, apiMentionRate } = mixed.metrics.visitorApiDivergence;
	return (
		<div className="rounded-lg border border-[#e5dbcd] bg-[#fffdf8] p-4 text-sm">
			<h3 className="font-semibold text-[#3d362e]">
				{tr(locale, "Visitor View and API View, separately", "Visitor View и API View, раздельно")}
			</h3>
			<p className="mt-2 text-[#6e6258]">
				{tr(locale, "What a visitor is shown", "Что видит посетитель")}:{" "}
				{formatShare(visitorMentionRate) ?? tr(locale, "unknown", "неизвестно")} ·{" "}
				{tr(locale, "what the model answers directly", "что модель отвечает напрямую")}:{" "}
				{formatShare(apiMentionRate) ?? tr(locale, "unknown", "неизвестно")}
			</p>
		</div>
	);
}

function ResultsPanel({ project, locale }: { project: WorkspaceProject; locale: WorkspaceLocale }) {
	const { access } = Route.useLoaderData();
	const result = project.recommendation;
	const measurementReady = project.measurement?.status === "READY";
	return (
		<section className="selena-section" aria-labelledby="results-title">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h2 id="results-title" className="selena-heading text-2xl">
						{tr(locale, "6 · Results and next actions", "6 · Результаты и следующие действия")}
					</h2>
					<p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">
						{tr(
							locale,
							"The website action plan and AI visibility report are separate. A website review never counts as an AI mention.",
							"План улучшения сайта и отчёт о видимости в AI показываются отдельно. Проверка сайта не считается упоминанием в AI.",
						)}
					</p>
				</div>
				{result && (
					<span className="flex flex-wrap items-center gap-3">
						<span className="selena-success-label">
							<IconSparkles className="size-4" /> {tr(locale, "Website plan ready", "План для сайта готов")}
						</span>
						<Link to="/app/selena-report" search={{ project: project.project.id }}>
							<Button type="button" variant="outline" size="sm" className="border-[#cdbdac] bg-[#fffdf8]">
								{tr(locale, "Open as a report", "Открыть отчётом")}
							</Button>
						</Link>
					</span>
				)}
			</div>

			<div className="mt-7 space-y-8">
				<div>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h3 className="text-sm font-semibold text-[#181614]">
							{tr(locale, "Website action plan", "План улучшения сайта")}
						</h3>
						<span className="text-xs font-medium text-[#6e6258]">{tr(locale, "Public website", "Публичный сайт")}</span>
					</div>
					{result ? (
						<>
							<dl className="grid gap-5 border-y border-[#e6ddd1] py-5 sm:grid-cols-3">
								<ResultMetric label={tr(locale, "Findings", "Наблюдения")} value={result.findingsCount} />
								<ResultMetric
									label={tr(locale, "Recommendations", "Рекомендации")}
									value={result.recommendationsCount}
								/>
								<ResultMetric label={tr(locale, "Action tasks", "Задачи")} value={result.tasksCount} />
							</dl>
							{result.topActions.length > 0 && (
								<div>
									<h3 className="text-sm font-semibold text-[#181614]">
										{tr(
											locale,
											`Priority actions — top ${Math.min(3, result.recommendationsCount)} of ${result.recommendationsCount}`,
											`Приоритетные действия — первые ${Math.min(3, result.recommendationsCount)} из ${result.recommendationsCount}`,
										)}
									</h3>
									<ul className="mt-3 divide-y divide-[#e6ddd1]">
										{result.topActions.map((item) => (
											<li
												key={`${item.priority}:${item.title}`}
												className="grid gap-1 py-4 sm:grid-cols-[5rem_1fr] sm:gap-5"
											>
												<span className="text-xs font-semibold text-[#8f5c34]">
													{priorityLabel(item.priority, locale)}
												</span>
												<div>
													<p className="font-medium text-[#181614]">
														{ruleTitle(locale, item.ruleId, item.title)}
														{item.ruleId && (
															<span className="ml-2 align-middle text-[0.62rem] font-semibold uppercase text-[#b0a294]">
																{item.ruleId}
															</span>
														)}
													</p>
													<p className="mt-1 text-sm leading-6 text-[#6e6258]">
														{ruleHow(locale, item.ruleId, item.action)}
													</p>
													<details className="mt-2">
														<summary className="cursor-pointer text-xs font-semibold text-[#8f5c34] underline underline-offset-4 [&::-webkit-details-marker]:hidden">
															{tr(locale, "How to fix →", "Как исправить →")}
														</summary>
														<div className="mt-2 rounded-lg border border-[#e6ddd1] bg-[#fbf7ef] p-3">
															{ruleSteps(locale, item.ruleId).length > 0 ? (
																<ol className="list-decimal space-y-1 pl-4 text-xs leading-5 text-[#3d362e]">
																	{ruleSteps(locale, item.ruleId).map((step) => (
																		<li key={step}>{step}</li>
																	))}
																</ol>
															) : (
																<p className="text-xs leading-5 text-[#3d362e]">{item.action}</p>
															)}
															{ruleExample(locale, item.ruleId) && (
																<p className="mt-2 rounded border border-[#e6ddd1] bg-[#fffdf8] px-2.5 py-1.5 font-mono text-[0.68rem] leading-4 text-[#3d362e]">
																	{tr(locale, "Done right: ", "Как правильно: ")}
																	{ruleExample(locale, item.ruleId)}
																</p>
															)}
															<button
																type="button"
																className="mt-2 rounded-full border border-[#cdbdac] bg-[#fffdf8] px-3.5 py-1.5 text-xs font-semibold text-[#8f5c34]"
																onClick={(event) => {
																	void navigator.clipboard.writeText(
																		ruleFixTask(
																			locale,
																			item.ruleId,
																			project.profile?.primaryDomain ?? "",
																			item.title,
																			item.action,
																		),
																	);
																	event.currentTarget.textContent = tr(locale, "Copied", "Скопировано");
																}}
															>
																{tr(
																	locale,
																	"Copy a task for an AI developer",
																	"Скопировать задание для AI-разработчика",
																)}
															</button>
														</div>
													</details>
												</div>
											</li>
										))}
									</ul>
									{result.recommendationsCount > 3 && (
										<Link
											to="/app/selena-report"
											search={{ project: project.project.id }}
											className="mt-3 inline-block"
										>
											<span className="text-sm font-semibold text-[#8f5c34] underline underline-offset-4">
												{tr(
													locale,
													`See all ${result.recommendationsCount} actions in the report →`,
													`Все ${result.recommendationsCount} действий — в полном отчёте →`,
												)}
											</span>
										</Link>
									)}
								</div>
							)}
						</>
					) : (
						<p className="mt-4 max-w-2xl border-t border-[#e6ddd1] pt-5 text-sm leading-6 text-[#6e6258]">
							{tr(
								locale,
								"Your first recommendations will appear after the website review.",
								"Первые рекомендации появятся после проверки сайта.",
							)}
						</p>
					)}
				</div>

				<div className="border-t border-[#e6ddd1] pt-7">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h3 className="text-sm font-semibold text-[#181614]">
							{tr(locale, "AI visibility report", "Отчёт о видимости в AI")}
						</h3>
						<span className={measurementReady ? "selena-success-label" : "text-xs font-medium text-[#6e6258]"}>
							{measurementReady
								? tr(locale, "Report ready", "Отчёт готов")
								: project.measurement
									? humanStatus(project.measurement.status, locale)
									: tr(locale, "Not started", "Не начат")}
						</span>
					</div>
					<div className="mt-4 grid gap-3 sm:grid-cols-2">
						<ChannelSummary
							title="Visitor View"
							systems="ChatGPT · Gemini · Perplexity"
							description={tr(
								locale,
								"What customers see in live AI answer surfaces.",
								"Что клиенты видят в пользовательских AI-сервисах.",
							)}
							href={orderPlanUrl(project.project.id, "snapshot", access.isAdmin)}
							planLabel={tr(locale, "Snapshot plan · $49/mo", "План Snapshot · $49/мес")}
						/>
						<ChannelSummary
							title="API View"
							systems="Claude · DeepSeek · Qwen · Mistral · Grok"
							description={tr(
								locale,
								"A separate model-knowledge baseline without web search by default.",
								"Отдельная проверка знаний моделей; веб-поиск по умолчанию выключен.",
							)}
							href={orderPlanUrl(project.project.id, "landscape", access.isAdmin)}
							planLabel={tr(locale, "In the Landscape plan · $79/mo", "Входит в Landscape · $79/мес")}
						/>
					</div>
					{project.measurement ? (
						<p className="mt-4 text-sm text-[#6e6258]">
							{locale === "ru"
								? `Проверено ответов: ${project.measurement.completedRuns} из ${project.measurement.expectedRuns}`
								: `${project.measurement.completedRuns} of ${project.measurement.expectedRuns} answers checked`}
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

/**
 * The plan ladder, not the AI-audit brief: someone who just finished a free
 * website review is buying a visibility measurement, and the audit form asks
 * about a different product entirely. The card lands on the in-app order
 * form with the plan and project pre-selected — there is no online checkout,
 * so the form takes a request (and a promo code) instead of a payment.
 */
function orderPlanUrl(projectId: string, plan: "snapshot" | "landscape", isAdmin: boolean): string {
	// An admin who follows the client form ends up sending herself a lead and
	// waiting for herself to answer it. The desk starts the measurement.
	if (isAdmin) return "/app/selena-admin";
	return `/app/selena-order?plan=${plan}&project=${projectId}`;
}

function ChannelSummary({
	title,
	systems,
	description,
	href,
	planLabel,
}: {
	title: string;
	systems: string;
	description: string;
	href: string;
	planLabel: string;
}) {
	return (
		<a
			href={href}
			className="block rounded-xl border border-[#e6ddd1] bg-[#fbf7f1] p-4 transition-colors hover:border-[#8f5c34]"
		>
			<p className="font-medium text-[#181614]">{title}</p>
			<p className="mt-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#8f5c34]">{systems}</p>
			<p className="mt-2 text-sm leading-6 text-[#6e6258]">{description}</p>
			<p className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#8f5c34]">
				{planLabel} <IconArrowRight className="size-4" />
			</p>
		</a>
	);
}

function ResultMetric({ label, value }: { label: string; value: number }) {
	return (
		<div>
			<dt className="text-xs font-medium text-[#6e6258]">{label}</dt>
			<dd className="selena-heading mt-1 text-3xl text-[#181614]">{value}</dd>
		</div>
	);
}

function Field({
	label,
	hint,
	htmlFor,
	children,
}: {
	label: string;
	hint?: string;
	htmlFor: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={htmlFor} className="text-[#302b27]">
				{label}
			</Label>
			{children}
			{hint && <p className="text-xs leading-5 text-[#75695f]">{hint}</p>}
		</div>
	);
}

type Feedback = { notice: string; error: string };

function FormFeedback({ feedback, className }: { feedback?: Feedback; className?: string }) {
	if (!feedback?.notice && !feedback?.error) return null;
	return (
		<div className={`space-y-3 ${className ?? ""}`}>
			{feedback.notice && <StatusMessage tone="success">{feedback.notice}</StatusMessage>}
			{feedback.error && <StatusMessage tone="error">{feedback.error}</StatusMessage>}
		</div>
	);
}

function StatusMessage({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
	return (
		<p
			role={tone === "error" ? "alert" : "status"}
			className={tone === "error" ? "selena-message selena-message-error" : "selena-message selena-message-success"}
		>
			{children}
		</p>
	);
}

function WorkspaceSkeleton() {
	return (
		<div className="selena-app min-h-screen px-5 py-10 sm:px-8">
			<div className="mx-auto max-w-7xl animate-pulse space-y-6">
				<div className="h-8 w-48 rounded bg-[#e6ddd1]" />
				<div className="h-56 rounded-2xl bg-[#e6ddd1]" />
				<div className="h-72 rounded-2xl bg-[#eee6dc]" />
			</div>
		</div>
	);
}

/** Comma is what the hints ask for, but the box above takes one per line. */
function splitList(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function readObjectString(value: unknown, key: string): string {
	if (!value || typeof value !== "object") return "";
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : "";
}

function parseScenario(line: string, fallbackLanguage: string) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^([a-z]{2}(?:-[A-Z]{2})?)\s*:\s*(.+)$/i);
	return {
		text: match?.[2]?.trim() || trimmed,
		language: (match?.[1] || fallbackLanguage).toLowerCase(),
		intentType: "discovery",
	};
}

/**
 * The most recent check this project has actually had — the AI measurement
 * when one exists, otherwise the website review. Nothing checked yet reads as
 * exactly that, not as a blank.
 */
function lastAuditLabel(project: WorkspaceProject, locale: WorkspaceLocale): string {
	if (project.measurement)
		return `${tr(locale, "AI measurement", "AI-замер")}: ${formatDate(project.measurement.updatedAt, locale)}`;
	if (project.website)
		return `${tr(locale, "Website audit", "Аудит сайта")}: ${formatDate(project.website.capturedAt, locale)}`;
	return tr(locale, "Not audited yet", "Проверок ещё не было");
}

function projectStageLabel(project: WorkspaceProject, locale: WorkspaceLocale): string {
	if (project.measurement?.status === "READY") return tr(locale, "AI report ready", "Отчёт AI готов");
	if (project.measurement) return humanStatus(project.measurement.status, locale);
	if (project.recommendation) return tr(locale, "Website action plan ready", "План для сайта готов");
	if (project.website) return tr(locale, "Website review saved", "Проверка сайта сохранена");
	if (project.profile) return tr(locale, "Ready for website review", "Можно проверять сайт");
	return tr(locale, "Profile needed", "Заполните профиль");
}

function humanStatus(value: string, locale: WorkspaceLocale): string {
	const status = value
		.toLowerCase()
		.replaceAll("_", " ")
		.replace(/^./, (letter) => letter.toUpperCase());
	if (locale === "en") return status;
	const translations: Record<string, string> = {
		Draft: "Черновик",
		Pending: "Ожидает",
		Running: "Выполняется",
		Ready: "Готово",
		Failed: "Ошибка",
		Cancelled: "Отменено",
	};
	return translations[status] ?? status;
}

function priorityLabel(value: string, locale: WorkspaceLocale): string {
	if (value === "NOW") return tr(locale, "Do now", "Сейчас");
	if (value === "NEXT") return tr(locale, "Do next", "Следом");
	return tr(locale, "Later", "Позже");
}

function formatDate(value: string, locale: WorkspaceLocale): string {
	return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en", { dateStyle: "medium" }).format(new Date(value));
}

function tr(locale: WorkspaceLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}
