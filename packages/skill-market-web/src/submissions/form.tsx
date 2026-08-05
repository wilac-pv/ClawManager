import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { For, Show, createEffect, createSignal, type JSX } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type SubmissionWriter = Pick<SkillMarketControlDataSource["submissions"], "create" | "revise">

export type SubmissionFormMode =
  | {
      readonly kind: "create"
      readonly initial?: SkillMarketControl.SubmissionMetadata
      readonly target?: SkillMarketControl.PublicationTarget
      readonly audience?: SkillMarketControl.AudienceTarget
    }
  | {
      readonly kind: "version"
      readonly initial: SkillMarketControl.SubmissionMetadata
      readonly target?: SkillMarketControl.PublicationTarget
      readonly audience?: SkillMarketControl.AudienceTarget
    }
  | {
      readonly kind: "revision"
      readonly submissionID: string
      readonly expectedVersion: number
      readonly initial: SkillMarketControl.SubmissionMetadata
      readonly target?: SkillMarketControl.PublicationTarget
      readonly audience?: SkillMarketControl.AudienceTarget
    }

interface SubmissionFormProps {
  readonly source: SubmissionWriter
  readonly groups?: Pick<SkillMarketControlDataSource["groups"], "list">
  readonly department?: SkillMarketControl.Department
  readonly mode?: SubmissionFormMode
  readonly onAccepted: (submissionID: string) => void
  readonly onConflict?: () => void
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
const packageLimit = 50 * 1024 * 1024
const iconLimit = 1024 * 1024

export function SubmissionForm(props: SubmissionFormProps) {
  const initial = props.mode?.initial
  const [fields, setFields] = createStore({
    target: props.mode?.target ?? ("company" as SkillMarketControl.PublicationTarget),
    version: initial?.version ?? "",
    displayName: initial?.displayName ?? "",
    description: initial?.description ?? "",
    category: initial?.category ?? "",
    tags: initial?.tags.join(", ") ?? "",
    license: initial?.license ?? "",
    requiresApiKey: initial?.requiresApiKey ?? false,
    changeNotes: "",
    packageFile: undefined as File | undefined,
    iconFile: undefined as File | undefined,
  })
  const [validationErrors, setValidationErrors] = createSignal<Record<string, string>>({})
  const [groupIDs, setGroupIDs] = createSignal<SkillMarketControl.GroupID[]>(
    props.mode?.audience?.scope === "groups" ? [...props.mode.audience.groupIDs] : [],
  )
  const [availableGroups, setAvailableGroups] = createSignal<SkillMarketControl.MarketGroup[]>([])
  const [groupLoadState, setGroupLoadState] = createSignal<"idle" | "pending" | "loaded" | "error">("idle")
  const [requestError, setRequestError] = createSignal<string>()
  const [pending, setPending] = createSignal(false)
  const [idempotencyKey, setIdempotencyKey] = createSignal(createIdempotencyKey())
  const [errorSummary, setErrorSummary] = createSignal<HTMLDivElement>()
  const loadGroups = () => {
    if (!props.groups || groupLoadState() !== "idle") return
    setGroupLoadState("pending")
    void props.groups
      .list()
      .then((page) => {
        setAvailableGroups([...page.managed, ...page.joined].filter((group) => group.status === "active"))
        setGroupLoadState("loaded")
      })
      .catch(() => setGroupLoadState("error"))
  }
  createEffect(() => {
    if (fields.target === "groups") loadGroups()
  })
  const mode = () => props.mode?.kind ?? "create"
  const markEdited = () => {
    setIdempotencyKey(createIdempotencyKey())
    setRequestError(undefined)
  }
  const focusError = () => queueMicrotask(() => errorSummary()?.focus())
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (pending()) return
    const errors = validate(fields, groupIDs(), props.department, mode() !== "revision")
    setValidationErrors(errors)
    setRequestError(undefined)
    if (Object.keys(errors).length > 0) return focusError()
    const metadata = createMetadata(fields)
    const input = {
      target: fields.target,
      ...(fields.target === "groups" ? { audience: { scope: "groups" as const, groupIDs: groupIDs() } } : {}),
      ...(fields.target === "department" ? { audience: { scope: "department" as const } } : {}),
      metadata,
      package: fields.packageFile!,
      ...(fields.iconFile ? { icon: fields.iconFile } : {}),
    }
    const request =
      props.mode?.kind === "revision"
        ? props.source.revise(
            props.mode.submissionID,
            { ...input, expectedVersion: props.mode.expectedVersion },
            idempotencyKey(),
          )
        : props.source.create(input, idempotencyKey())
    setPending(true)
    void request
      .then((result) => props.onAccepted(result.submission.id))
      .catch((error: unknown) => {
        if (error instanceof MarketControlError && error.code === "submission-conflict") props.onConflict?.()
        if (error instanceof MarketControlError) setIdempotencyKey(createIdempotencyKey())
        setRequestError(
          error instanceof MarketControlError
            ? `${error.message}（请求编号：${error.requestId}）`
            : "上传失败，请检查网络后重试；内容未修改时会复用同一请求。",
        )
        focusError()
      })
      .finally(() => setPending(false))
  }

  return (
    <main class="submission-page submission-form-page">
      <header class="submission-page__heading">
        <div>
          <p class="submission-page__eyebrow">Skill 包</p>
          <h1>{mode() === "revision" ? "提交修订" : mode() === "version" ? "提交新版本" : "投稿 Skill"}</h1>
          <p>
            {fields.target === "personal"
              ? "上传 ZIP 包后将自动校验和安全扫描，扫描通过后立即进入个人空间。"
              : "上传 ZIP 包后将自动校验和安全扫描，通过人工审核后上架。"}
          </p>
        </div>
      </header>

      <form class="submission-form" aria-busy={pending()} onSubmit={submit} onInput={markEdited} noValidate>
        <Show when={Object.keys(validationErrors()).length > 0 || requestError()}>
          <div class="submission-form__errors" role="alert" tabIndex={-1} ref={setErrorSummary}>
            <strong>请检查以下问题</strong>
            <Show when={requestError()}>{(message) => <p>{message()}</p>}</Show>
            <ul>
              <For each={Object.values(validationErrors())}>{(message) => <li>{message}</li>}</For>
            </ul>
          </div>
        </Show>

        <section class="submission-form__section submission-form__section--target">
          <div>
            <span class="submission-targets__eyebrow">发布范围</span>
            <h2>保存位置</h2>
            <p>选择 Skill 扫描通过后的可见范围，后续版本会沿用这个位置。</p>
          </div>
          <fieldset class="submission-targets">
            <legend>选择保存位置</legend>
            <label
              class="submission-target-card"
              classList={{ "submission-target-card--selected": fields.target === "personal" }}
            >
              <span class="submission-target-card__icon submission-target-card__icon--personal" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                  <rect x="5" y="10" width="14" height="10" rx="3" />
                  <path d="M12 14v2" />
                </svg>
              </span>
              <span class="submission-target-card__body">
                <span class="submission-target-card__title">
                  <strong>个人空间</strong>
                  <small class="submission-target-card__badge">立即可用</small>
                </span>
                <small>扫描通过立即可用，仅本人可见。</small>
              </span>
              <input
                class="submission-target-card__input"
                type="radio"
                name="target"
                value="personal"
                checked={fields.target === "personal"}
                onChange={() => setFields("target", "personal")}
              />
            </label>
            <label
              class="submission-target-card"
              classList={{ "submission-target-card--selected": fields.target === "groups" }}
            >
              <span class="submission-target-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <circle cx="8" cy="8" r="3" />
                  <circle cx="16" cy="9" r="3" />
                  <path d="M3 20c0-4 2-6 5-6s5 2 5 6M13 15c4-1 7 1 8 5" />
                </svg>
              </span>
              <span class="submission-target-card__body">
                <span class="submission-target-card__title">
                  <strong>指定小组</strong>
                  <small class="submission-target-card__badge submission-target-card__badge--review">人工审核</small>
                </span>
                <small>扫描后人工审核，可选择你管理或加入的多个启用小组。</small>
              </span>
              <input
                class="submission-target-card__input"
                type="radio"
                name="target"
                value="groups"
                checked={fields.target === "groups"}
                onChange={() => {
                  setFields("target", "groups")
                  loadGroups()
                }}
              />
            </label>
            <label
              class="submission-target-card"
              classList={{ "submission-target-card--selected": fields.target === "department" }}
            >
              <span class="submission-target-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 20h16M6 20V6h8v14M14 10h4v10M9 10h2m-2 4h2" />
                </svg>
              </span>
              <span class="submission-target-card__body">
                <span class="submission-target-card__title">
                  <strong>本部门</strong>
                  <small class="submission-target-card__badge submission-target-card__badge--review">人工审核</small>
                </span>
                <small>
                  {props.department
                    ? `扫描后人工审核，仅 ${props.department.name} 可见。`
                    : "当前账号没有部门信息，无法选择本部门。"}
                </small>
              </span>
              <input
                class="submission-target-card__input"
                type="radio"
                name="target"
                value="department"
                disabled={!props.department}
                checked={fields.target === "department"}
                onChange={() => setFields("target", "department")}
              />
            </label>
            <label
              class="submission-target-card"
              classList={{ "submission-target-card--selected": fields.target === "company" }}
            >
              <span class="submission-target-card__icon submission-target-card__icon--company" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 20h16M6 20V8l6-4 6 4v12M9 11h1m4 0h1m-6 4h1m4 0h1" />
                </svg>
              </span>
              <span class="submission-target-card__body">
                <span class="submission-target-card__title">
                  <strong>全公司</strong>
                  <small class="submission-target-card__badge submission-target-card__badge--review">人工审核</small>
                </span>
                <small>扫描后人工审核，全公司可见。</small>
              </span>
              <input
                class="submission-target-card__input"
                type="radio"
                name="target"
                value="company"
                checked={fields.target === "company"}
                onChange={() => setFields("target", "company")}
              />
            </label>
          </fieldset>
          <Show when={fields.target === "groups"}>
            <fieldset class="submission-group-picker">
              <legend>选择小组</legend>
              <Show
                when={groupLoadState() === "loaded"}
                fallback={
                  <Show when={groupLoadState() === "error"} fallback={<p role="status">正在加载可选小组…</p>}>
                    <p role="alert">
                      可选小组加载失败，请重试。
                      <button
                        type="button"
                        onClick={() => {
                          setGroupLoadState("idle")
                          loadGroups()
                        }}
                      >
                        重新加载
                      </button>
                    </p>
                  </Show>
                }
              >
                <Show when={availableGroups().length > 0} fallback={<p>你当前没有可用于分享的启用小组。</p>}>
                  <For each={availableGroups()}>
                    {(group) => (
                      <label>
                        <input
                          type="checkbox"
                          aria-label={group.name}
                          checked={groupIDs().includes(group.id)}
                          onChange={(event) =>
                            setGroupIDs((current) =>
                              event.currentTarget.checked
                                ? [...current, group.id]
                                : current.filter((groupID) => groupID !== group.id),
                            )
                          }
                        />
                        <span>{group.name}</span>
                      </label>
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={validationErrors().audience}>
                {(error) => <small class="submission-form__field-error">{error()}</small>}
              </Show>
            </fieldset>
          </Show>
        </section>

        <section class="submission-form__section">
          <div>
            <h2>基本信息</h2>
            <p>
              {fields.target === "personal"
                ? "这些信息仅在你的个人空间展示。"
                : fields.target === "company"
                  ? "这些信息会在审核通过后展示在公司市场。"
                  : "这些信息会在审核通过后展示给选定范围。"}
            </p>
          </div>
          <div class="submission-form__fields">
            <Field label="版本号" description="使用 SemVer，例如 1.2.0。" error={validationErrors().version}>
              <input
                aria-label="版本号"
                value={fields.version}
                onInput={(event) => setFields("version", event.currentTarget.value)}
                aria-invalid={Boolean(validationErrors().version)}
              />
            </Field>
            <Field label="Skill 名称" error={validationErrors().displayName}>
              <input
                aria-label="Skill 名称"
                value={fields.displayName}
                onInput={(event) => setFields("displayName", event.currentTarget.value)}
                aria-invalid={Boolean(validationErrors().displayName)}
              />
            </Field>
            <Field label="简介" error={validationErrors().description} wide>
              <textarea
                aria-label="简介"
                rows="4"
                value={fields.description}
                onInput={(event) => setFields("description", event.currentTarget.value)}
                aria-invalid={Boolean(validationErrors().description)}
              />
            </Field>
            <Field label="分类" error={validationErrors().category}>
              <input
                aria-label="分类"
                value={fields.category}
                onInput={(event) => setFields("category", event.currentTarget.value)}
                aria-invalid={Boolean(validationErrors().category)}
              />
            </Field>
            <Field label="标签" description="使用逗号分隔，最多 20 个。">
              <input
                aria-label="标签"
                value={fields.tags}
                onInput={(event) => setFields("tags", event.currentTarget.value)}
              />
            </Field>
            <Field label="许可证（可选）">
              <input
                aria-label="许可证（可选）"
                value={fields.license}
                onInput={(event) => setFields("license", event.currentTarget.value)}
              />
            </Field>
            <label class="submission-form__checkbox">
              <input
                aria-label="需要 API Key"
                type="checkbox"
                checked={fields.requiresApiKey}
                onChange={(event) => setFields("requiresApiKey", event.currentTarget.checked)}
              />
              <span>
                <strong>需要 API Key</strong>
                <small>启用后，市场会明确提示用户配置外部凭据。</small>
              </span>
            </label>
            <Field label="变更说明" error={validationErrors().changeNotes} wide>
              <textarea
                aria-label="变更说明"
                rows="4"
                value={fields.changeNotes}
                onInput={(event) => setFields("changeNotes", event.currentTarget.value)}
                aria-invalid={Boolean(validationErrors().changeNotes)}
              />
            </Field>
          </div>
        </section>

        <section class="submission-form__section">
          <div>
            <h2>上传文件</h2>
            <p>浏览器只负责上传文件，最终限制与安全判断由服务端执行。</p>
          </div>
          <div class="submission-form__fields">
            <Field label="Skill ZIP 包" description="必填，最大 50 MiB。" error={validationErrors().packageFile} wide>
              <input
                aria-label="Skill ZIP 包"
                type="file"
                accept=".zip,application/zip"
                aria-invalid={Boolean(validationErrors().packageFile)}
                onChange={(event) => {
                  setFields("packageFile", event.currentTarget.files?.[0])
                  markEdited()
                }}
              />
            </Field>
            <Field
              label="Skill 图标（可选）"
              description="PNG、JPEG 或 WebP，最大 1 MiB。"
              error={validationErrors().iconFile}
              wide
            >
              <input
                aria-label="Skill 图标（可选）"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-invalid={Boolean(validationErrors().iconFile)}
                onChange={(event) => {
                  setFields("iconFile", event.currentTarget.files?.[0])
                  markEdited()
                }}
              />
            </Field>
          </div>
        </section>

        <footer class="submission-form__actions">
          <A href={fields.target === "personal" ? "/personal" : "/submissions"}>取消</A>
          <button type="submit" class="market-primary-action" disabled={pending()}>
            {pending()
              ? "正在提交…"
              : requestError()
                ? "重试提交"
                : fields.target === "personal"
                  ? "上传到个人空间"
                  : "提交审核"}
          </button>
          <Show when={pending()}>
            <span role="status">正在上传，请勿关闭页面…</span>
          </Show>
        </footer>
      </form>
    </main>
  )
}

function Field(props: { label: string; description?: string; error?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <label class="submission-form__field" classList={{ "submission-form__field--wide": props.wide }}>
      <span>{props.label}</span>
      <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
      {props.children}
      <Show when={props.error}>{(error) => <small class="submission-form__field-error">{error()}</small>}</Show>
    </label>
  )
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function validate(fields: {
  target: SkillMarketControl.PublicationTarget
  version: string
  displayName: string
  description: string
  category: string
  tags: string
  license: string
  changeNotes: string
  packageFile?: File
  iconFile?: File
}, groupIDs: ReadonlyArray<SkillMarketControl.GroupID>, department?: SkillMarketControl.Department, validateAudience = true) {
  const errors: Record<string, string> = {}
  if (!fields.version.trim()) errors.version = "版本号不能为空"
  if (fields.version.trim() && !semver.test(fields.version.trim())) errors.version = "请输入有效的 SemVer 版本号"
  if (!fields.displayName.trim()) errors.displayName = "名称不能为空"
  if (!fields.description.trim()) errors.description = "描述不能为空"
  if (!fields.category.trim()) errors.category = "分类不能为空"
  if (!fields.changeNotes.trim()) errors.changeNotes = "变更说明不能为空"
  const tags = parseTags(fields.tags)
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) errors.tags = "标签最多 20 个，每个不超过 40 个字符"
  if (fields.displayName.trim().length > 120) errors.displayName = "名称不能超过 120 个字符"
  if (fields.description.trim().length > 1_000) errors.description = "描述不能超过 1000 个字符"
  if (fields.category.trim().length > 80) errors.category = "分类不能超过 80 个字符"
  if (fields.license.trim().length > 100) errors.license = "许可证不能超过 100 个字符"
  if (fields.changeNotes.trim().length > 2_000) errors.changeNotes = "变更说明不能超过 2000 个字符"
  if (!fields.packageFile) errors.packageFile = "请选择 ZIP 包"
  if (fields.packageFile && !fields.packageFile.name.toLowerCase().endsWith(".zip"))
    errors.packageFile = "请选择 .zip 文件"
  if (fields.packageFile && fields.packageFile.size > packageLimit) errors.packageFile = "ZIP 包不能超过 50 MiB"
  if (fields.iconFile && fields.iconFile.size > iconLimit) errors.iconFile = "图标不能超过 1 MiB"
  if (validateAudience && fields.target === "groups" && groupIDs.length === 0) errors.audience = "请至少选择一个小组"
  if (validateAudience && fields.target === "department" && !department) errors.audience = "当前账号没有部门信息"
  return errors
}

function createMetadata(fields: {
  version: string
  displayName: string
  description: string
  category: string
  tags: string
  license: string
  requiresApiKey: boolean
  changeNotes: string
}): SkillMarketControl.SubmissionMetadata {
  const license = fields.license.trim()
  return {
    version: fields.version.trim(),
    displayName: fields.displayName.trim(),
    description: fields.description.trim(),
    category: fields.category.trim(),
    tags: parseTags(fields.tags),
    ...(license ? { license } : {}),
    requiresApiKey: fields.requiresApiKey,
    changeNotes: fields.changeNotes.trim(),
  }
}

function parseTags(value: string) {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}
