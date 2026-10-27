/**
 * Browser half of `dsh-connect-zcode`: the model-selection card shown on this plugin's
 * page in the Plugins section.
 *
 * The card lives where the Plugins page puts every plugin's configuration — the keyed
 * `plugins.bundle.config` / `plugins.row.config` slots — so there is no extra icon in the
 * left rail. It lists the Host's advertised catalogue with one switch per model, and every
 * switch writes this plugin's own config section, so the adapter's existing
 * `enabledModelIds` / `disabledModelIds` filter is the only thing that has to change on the
 * Host side.
 *
 * Why this shape:
 * - The bundle is served as a classic script and must register itself through
 *   `window.__ModuleLoader__.load({ id, factory })`; the file therefore holds no
 *   top-level declarations at all (combo scripts are concatenated) and no
 *   `import`/`export` statements (they would not parse as a classic script).
 * - `apply`/`inject`/`name` are the plugin body, mirroring the shipped client
 *   halves (dsh-connect-workbuddy registers the same two keyed slots for its cards).
 * - A Host-side failure must never cost the user the model provider, so the
 *   whole body is wrapped: a broken slot or settings API degrades to a
 *   `console.error` instead of the loader's red "failed to load plugins" banner.
 *
 * @module dsh-connect-zcode/client
 */

/** @type {any} */ (globalThis).__ModuleLoader__.load({
  id: "dsh-connect-zcode",
  /**
   * Materialise the bundle: register `apply`, `inject`, and `name`.
   *
   * @param {(id: string) => any} require - the bundle's synchronous resolver,
   *   answered from the frozen platform module table (react, primitives, locale).
   * @returns {any} the module exports the loader keeps.
   */
  factory: function (require) {
    /** @type {any} */
    var module = { exports: {} }
    /** @type {any} */
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    // Resolved through an alias: a bare `require("react")` call would make the
    // typechecker resolve the specifier against this package's own dependencies,
    // which by design do not include the Host's browser module table.
    /** @type {(id: string) => any} */
    const resolveModule = require
    const React = resolveModule("react")
    const h = React.createElement

    // The primitives package is a declared client dependency, but the panel must
    // still render if a deployment seeds an older module table: each helper below
    // falls back to the plain DOM equivalent.
    /** @type {any} */
    let primitives = {}
    try {
      primitives = resolveModule("@deepseek-ai/dsh-client-ui-primitives") || {}
    } catch {
      primitives = {}
    }

    /** Loader entry id; also the `settingsNs` the Host serves this plugin under. */
    const SETTINGS_NS = "dsh-connect-zcode"
    /**
     * Package name: the key the Plugins page dispatches `plugins.bundle.config` with, and
     * the prefix of the `<pkg>#<rowId>` key it dispatches `plugins.row.config` with.
     */
    const PACKAGE_NAME = "dsh-connect-zcode"
    /**
     * Every spelling the settings namespace can arrive under.
     *
     * `settings.describe` keys a form by its Loader *entry id*, and the profile patch
     * decides that id — so the plugin must ask rather than assume. Observed spellings are
     * the bare package name, the `include:`-wrapped id the Desktop host uses, and the
     * declared row name. `whileServed` is given all of them and re-runs when the settings
     * mirror finally arrives; watching only the bare name leaves the panel permanently
     * "配置不可用" on a host whose ids are prefixed (this was the reported defect).
     */
    const SETTINGS_NS_CANDIDATES = [
      SETTINGS_NS,
      `include:${SETTINGS_NS}`,
      PACKAGE_NAME,
    ]
    /**
     * The two model channels this plugin can register, and the config fields each one owns.
     *
     * WHY THIS EXISTS. The card used to be hard-wired to ONE provider id (`zcode-cli`) and
     * ONE pair of config fields (`enabledModelIds` / `disabledModelIds`). Once the direct
     * quota channel became the default (`transport: "plan"`), that assumption broke in the
     * worst possible way: the `zcode-cli` group no longer exists in the catalogue, so the
     * row list degenerated to whatever the LEGACY config still named — the fifteen
     * `claude-*` / `gpt-*` ids left over from the agent channel — drawn greyed out and
     * counted as "0 of 15". Meanwhile the four models the plugin actually serves
     * (`zcode-plan`) had no switches at all.
     *
     * So the panel is channel-aware: each channel contributes its own section, reads its
     * own catalogue group, and writes its own fields. The channels are NOT interchangeable
     * — `planEnabledModelIds` holds bare ids in merged mode but `<providerId>#<modelId>`
     * in explicit mode, while `enabledModelIds` holds CLI ids — which is exactly why one
     * shared list was wrong and why this must stay per-channel.
     *
     * @type {ReadonlyArray<{ key: string, provider: string, name: string, enabledField: string, disabledField: string }>}
     */
    const CHANNELS = [
      {
        key: "plan",
        provider: "zcode-plan",
        name: "zcode",
        enabledField: "planEnabledModelIds",
        disabledField: "planDisabledModelIds",
      },
      {
        key: "cli",
        provider: "zcode-cli",
        name: "zcode",
        enabledField: "enabledModelIds",
        disabledField: "disabledModelIds",
      },
    ]
    /** Locale namespace owned by this plugin. */
    const NS = "settings.zcode"
    /** Stable `<style>` identity so a reload replaces rather than stacks copies. */
    const STYLE_ID = "dsh-connect-zcode/panel.css"

    // ── copy ──────────────────────────────────────────────────────────────────

    /** Simplified Chinese copy (key-set source of truth). */
    const zh = {
      panel: "zcode",
      title: "zcode 模型",
      intro: "选择要在 DSH 模型选择器中出现的 ZCode 模型。改动先留在本地，点「保存」才会写入插件配置。",
      providerLine: "供应商 {name}（{id}）",
      enabledCount: "已启用 {n}/{total}",
      enableAll: "全部启用",
      retry: "重新读取",
      save: "保存",
      saving: "正在保存…",
      discard: "放弃修改",
      unsaved: "有未保存的修改",
      savedHint: "改动会立即生效",
      loading: "正在读取模型目录…",
      empty: "没有读取到任何 zcode 模型。ZCode 桌面客户端可能未安装、未登录，或供应商尚未注册。",
      catalogError: "读取模型目录失败：{message}",
      configUnavailable: "插件配置当前不可用——宿主已服务的配置命名空间：{served}。请把这段信息反馈给插件作者。",
      readOnly: "当前部署的插件配置为只读，改动无法保存。",
      writeFailed: "保存失败，配置已回滚到宿主状态：{message}",
      notReported: "未上报",
      // ── 通道分区（直连额度 / 托管 agent） ──────────────────────────────────
      channelPlan: "直连额度",
      channelCli: "托管 agent",
      channelPlanHint: "直接调用套餐端点的模型通道：不启动子进程，请求由本插件自己发出。",
      channelCliHint: "托管 ZCode agent 子进程的旧通道：由 agent 替我们发模型请求。",
      channelOff: "该通道当前未注册（{transport} 模式下不提供），所以这里没有可勾选的模型。",
      channelEmpty: "该通道没有读取到任何模型。客户端可能未安装、未登录，或供应商尚未注册。",
      routeMode: "路由模式",
      routeModeMerged: "merged（一个模型一条，套餐间自动切换）",
      routeModeExplicit: "explicit（每条路由一条，手动指定套餐）",
      pinnedCount: "{n} 个模型已钉死套餐，不会自动切换",
      diagProvider: "供应商 id",
      diagCatalog: "目录模型数",
      diagEnabled: "已启用",
      diagMode: "路由模式",
      diagNotReported: "未上报",
    }

    /** English copy. */
    const en = {
      panel: "zcode",
      title: "zcode models",
      intro: "Choose which ZCode models the model picker offers. Edits stay local until you press Save.",
      providerLine: "Provider {name} ({id})",
      enabledCount: "{n} of {total} enabled",
      enableAll: "Enable all",
      retry: "Reload",
      save: "Save",
      saving: "Saving…",
      discard: "Discard changes",
      unsaved: "Unsaved changes",
      savedHint: "Changes apply immediately",
      loading: "Reading the model catalogue…",
      empty: "No zcode model was reported. The ZCode desktop client may be missing or signed out, or the provider is not registered.",
      catalogError: "Could not read the model catalogue: {message}",
      configUnavailable: "This plugin's config is unavailable — the namespaces the Host serves are: {served}. Please report this line to the plugin author.",
      readOnly: "This deployment serves the plugin config read-only, so changes cannot be saved.",
      writeFailed: "Saving failed; the config was rolled back to the Host state: {message}",
      notReported: "not reported",
      channelPlan: "Direct quota",
      channelCli: "Managed agent",
      channelPlanHint: "Calls the plan endpoints directly: no child process, this plugin sends the request.",
      channelCliHint: "The legacy channel that hosts a ZCode agent subprocess and lets it send the request.",
      channelOff: "This channel is not registered under the current transport, so it has no selectable models.",
      channelEmpty: "This channel reported no models. The client may be missing or signed out, or the provider is not registered.",
      routeMode: "Route mode",
      routeModeMerged: "merged (one entry per model, auto-failover across plans)",
      routeModeExplicit: "explicit (one entry per route, plan chosen manually)",
      pinnedCount: "{n} model(s) pinned to a plan route, no failover",
      diagProvider: "Provider id",
      diagCatalog: "Catalogue models",
      diagEnabled: "Enabled",
      diagMode: "Route mode",
      diagNotReported: "not reported",
    }

    // ── styles ────────────────────────────────────────────────────────────────

    const CSS = [
      ".zcp-root{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 40px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:22px}",
      ".zcp-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;max-width:720px}",
      ".zcp-title{margin:0;font-size:18px;font-weight:600;line-height:26px}",
      ".zcp-count{color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}",
      ".zcp-actions{display:flex;gap:8px;margin-left:auto}",
      ".zcp-intro{margin:6px 0 0;max-width:720px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
      ".zcp-banner{margin:12px 0 0;max-width:720px;padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px}",
      ".zcp-banner[data-tone=error]{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}",
      ".zcp-banner[data-tone=warn]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}",
      ".zcp-list{margin:16px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;max-width:720px}",
      ".zcp-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-md)}",
      ".zcp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".zcp-check{flex:1;min-width:0}",
      ".zcp-check>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".zcp-id{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:18px}",
      ".zcp-native{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}",
      ".zcp-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:3px 10px;cursor:pointer}",
      ".zcp-btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}",
      ".zcp-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
      ".zcp-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".zcp-muted{color:var(--dsw-alias-label-tertiary);margin:16px 0 0;max-width:720px;font-size:13px}",
      ".zcp-sec{margin:20px 0 0;max-width:720px}",
      ".zcp-sec-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".zcp-sec-title{margin:0;font-size:14px;font-weight:600;line-height:22px}",
      ".zcp-sec .zcp-list{margin:8px 0 0}",
      ".zcp-sec .zcp-intro{margin:4px 0 0}",
      ".zcp-sec .zcp-banner{margin:8px 0 0}",
      ".zcp-sec .zcp-muted{margin:8px 0 0}",
      ".zcp-diag{display:flex;flex-wrap:wrap;gap:16px;margin:6px 0 0;max-width:720px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".zcp-save{display:flex;align-items:center;gap:12px;margin:16px 0 0;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3);max-width:720px}",
      ".zcp-dirty{color:var(--dsw-alias-state-warn-label);font-size:13px}",
      ".zcp-save .zcp-muted{margin:0}",
    ].join("")

    /**
     * Inject the panel stylesheet once per document.
     *
     * @returns {void}
     */
    function injectStyle() {
      const doc = /** @type {any} */ (globalThis).document
      if (doc === undefined || doc === null) return
      if (doc.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const tag = doc.createElement("style")
      tag.dataset.plugin = "dsh-connect-zcode"
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      doc.head.appendChild(tag)
    }

    // ── primitives with DOM fallbacks ─────────────────────────────────────────

    /**
     * A button, through the shipped primitive when the module table provides it.
     *
     * @param {any} props - primitive props (`variant`, `size`, `disabled`, `onClick`, `children`).
     * @returns {any} the element.
     */
    function Button(props) {
      if (typeof primitives.Button === "function") return h(primitives.Button, props)
      return h(
        "button",
        { type: "button", className: "zcp-btn", disabled: props.disabled === true, onClick: props.onClick },
        props.children,
      )
    }

    /**
     * A checkbox whose visible label is the model name.
     *
     * @param {any} props - `checked`, `disabled`, `onChange(next)`, `label`.
     * @returns {any} the element.
     */
    function Checkbox(props) {
      if (typeof primitives.Checkbox === "function") return h(primitives.Checkbox, props)
      return h(
        "label",
        { className: "zcp-native" },
        h("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (/** @type {any} */ event) => props.onChange(event.target.checked === true),
        }),
        h("span", null, props.label),
      )
    }

    /**
     * A small status tag.
     *
     * @param {any} props - `tone`, `children`.
     * @returns {any} the element.
     */
    function Tag(props) {
      if (typeof primitives.Tag === "function") return h(primitives.Tag, props)
      return h("span", { className: "zcp-id" }, props.children)
    }

    // ── model directory ───────────────────────────────────────────────────────

    /**
     * Normalise a configured id list.
     *
     * @param {any} value - raw config value.
     * @returns {string[]} non-empty string ids.
     */
    function idList(value) {
      if (!Array.isArray(value)) return []
      return value.filter((/** @type {any} */ id) => typeof id === "string" && id !== "")
    }

    /**
     * One panel-scoped view over the Host's config section and model catalogue.
     *
     * The catalogue the Host advertises is already filtered by this plugin's
     * config, so a disabled model disappears from it. The row list is therefore
     * the UNION of the advertised models and the ids the config still names —
     * that is what keeps a switched-off model re-enableable.
     *
     * @param {any} ctx - the browser plugin context.
     * @returns {any} `{ subscribe, getSnapshot, start, dispose, setModel, enableAll, save, discard, reload }`.
     */
    function createDirectory(ctx) {
      /** @type {Set<() => void>} */
      const listeners = new Set()
      /** @type {any} */
      let snapshot = { status: "loading", rows: [], enabled: 0, total: 0, writable: false, bound: false, boundNamespace: undefined, served: [], error: null, writeError: null, writing: false }
      /** @type {any} */
      let controller
      /** @type {any} */
      let sessionRemote
      /** @type {any[]} */
      let groups = []
      let catalogStatus = "loading"
      /** @type {string | null} */
      let catalogError = null
      /**
       * Unsaved switch edits, keyed by `<channelKey>\u0000<modelId>`, or `undefined` when
       * the panel is clean.
       *
       * The channel is part of the key because the two channels can legitimately list the
       * same model id (a bare `GLM-5.3-Flash` exists in both) while writing to different
       * config fields. A draft keyed by model id alone would apply one channel's click to
       * the other.
       *
       * A draft is the whole point of the Save button: writing on every click also re-read
       * the (Host-filtered) catalogue on every click, so the list greyed out under the
       * pointer. Switching now only edits this map.
       *
       * @type {Map<string, boolean> | undefined}
       */
      let draft
      /** Draft of "everything enabled" per channel key (that channel's lists both empty). @type {Set<string>} */
      let clearAll = new Set()
      /** A save is in flight; edits are refused so the draft cannot shift under it. */
      let saving = false
      let writing = false
      /** @type {string | null} */
      let writeError = null
      let disposed = false
      /** @type {(() => void) | undefined} */
      let unsubscribe
      /** @type {any} */
      let forms
      /** @type {string | undefined} */
      let boundNamespace

      /**
       * Draft key for one switch.
       *
       * @param {string} channelKey - channel (`plan` / `cli`).
       * @param {string} id - model id within that channel.
       * @returns {string} draft map key.
       */
      const draftKey = (channelKey, id) => `${channelKey}\u0000${id}`

      /**
       * The namespaces the Host actually serves.
       *
       * `configForms.describe()` is the mirror every `ConfigFormController` derives from,
       * so this is the same data the Host uses to answer a form — reading it is how this
       * half ASKS which namespace exists instead of guessing. `whileServed` is built on the
       * same snapshot; both are used because the subscription covers later arrivals while
       * the direct read covers the already-answered case.
       *
       * @returns {string[]} served namespace spellings, possibly empty.
       */
      const servedNamespaces = () => {
        if (forms === undefined || forms === null || typeof forms.describe !== "function") return []
        try {
          const mirror = forms.describe()
          if (mirror === undefined || mirror === null || typeof mirror.getSnapshot !== "function") return []
          const view = mirror.getSnapshot().view
          if (view === undefined || view === null || !Array.isArray(view.namespaces)) return []
          /** @type {string[]} */
          const out = []
          for (const entry of view.namespaces) {
            const ns = entry === null || typeof entry !== "object" ? undefined : entry.ns
            if (typeof ns === "string" && ns !== "") out.push(ns)
          }
          return out
        } catch {
          return []
        }
      }

      /**
       * Pick the served namespace that belongs to this plugin.
       *
       * Preference is the candidate spellings in order, then anything zcode-shaped so a
       * deployment that renamed the Loader entry beyond recognition still binds.
       *
       * This function is the fix for the reported defect. The previous code called
       * `configForms.get(ns)` for each candidate and treated a truthy return as proof the
       * namespace was served — but `get()` LAZILY CONSTRUCTS a controller for ANY id
       * (`ConfigForms.get`: `new ConfigFormController(this.owner, { namespace: entryId }, …)`).
       * It therefore never returns undefined, so the first candidate always "succeeded" and
       * the card bound the BARE package name. The live host serves this plugin as
       * `include:dsh-connect-zcode`, and `ConfigFormController.derive()` matches namespaces
       * with EXACT equality, so that form reported `unavailable` forever: the red
       * "插件配置当前不可用" banner, a permanently dead switch list, and every write rejected
       * by the Host ("保存失败，配置已回滚到宿主状态").
       *
       * @param {readonly string[]} served - namespaces read from the mirror.
       * @returns {string | undefined} the namespace to bind, if one is served.
       */
      const resolveServedNamespace = (served) => {
        const list = Array.isArray(served) ? served : []
        for (const candidate of SETTINGS_NS_CANDIDATES) {
          if (list.includes(candidate)) return candidate
        }
        return list.find((ns) => typeof ns === "string" && ns.includes("zcode"))
      }

      /** @returns {void} */
      const publish = () => {
        if (disposed) return
        let config = controller === undefined ? undefined : controller.getSnapshot()

        // Self-heal: a controller bound to a namespace the Host does not serve reports
        // `unavailable` for its whole lifetime. If the mirror now names a namespace that
        // does belong here, move the binding instead of drawing an error banner.
        if (
          boundNamespace !== undefined
          && config !== undefined
          && config.status === "unavailable"
        ) {
          const target = resolveServedNamespace(servedNamespaces())
          if (target !== undefined && target !== boundNamespace) {
            boundNamespace = target
            controller = forms.get(target)
            if (typeof unsubscribe === "function") unsubscribe()
            unsubscribe = typeof controller.subscribe === "function" ? controller.subscribe(() => publish()) : undefined
            config = controller.getSnapshot()
          }
        }
        const value = config === undefined || config.value === null || config.value === undefined ? {} : config.value

        /**
         * One channel's section, derived from ITS catalogue group and ITS config fields.
         *
         * The union with the two config lists is what keeps a switched-off model listed and
         * re-enableable — but only this channel's lists. Mixing them was the reported
         * defect: with `transport: "plan"` the `zcode-cli` group is absent, and the legacy
         * `disabledModelIds` still named fifteen agent-era ids, so the card drew fifteen
         * greyed-out rows and hid the four models actually being served.
         *
         * @param {(typeof CHANNELS)[number]} channel - channel definition.
         * @returns {any} the section snapshot.
         */
        const sectionFor = (channel) => {
          const disabled = idList(value[channel.disabledField])
          const allow = idList(value[channel.enabledField])
          const group = groups.find((/** @type {any} */ candidate) => (
            candidate !== null && typeof candidate === "object" && candidate.id === channel.provider
          ))
          const models = group !== undefined && Array.isArray(group.models) ? group.models : []
          /** @type {Set<string>} */
          const advertised = new Set()
          /** @type {Map<string, string>} */
          const names = new Map()
          for (const model of models) {
            if (model === null || typeof model !== "object" || typeof model.id !== "string" || model.id === "") continue
            advertised.add(model.id)
            names.set(model.id, typeof model.name === "string" && model.name !== "" ? model.name : model.id)
          }
          const ids = Array.from(new Set([...advertised, ...disabled, ...allow])).sort((left, right) => left.localeCompare(right))
          /**
           * Whether one id is enabled, decided from THIS CHANNEL'S CONFIG.
           *
           * Not from catalogue membership: the Host already filters the advertised catalogue
           * through its selection rule, so a switched-off model simply vanishes from it and
           * an "is it present?" test only reflects whatever the last catalogue read
           * returned. Deriving the answer from the two config lists is the same rule the
           * Host applies (disabled wins, then enabled when non-empty, otherwise everything),
           * evaluated against the authoritative document instead of a derived view — so a
           * switch shows what the user just asked for even before the refreshed catalogue
           * arrives, and a slow or failed refresh cannot flip it back.
           *
           * @param {string} id - model id within this channel.
           * @returns {boolean} whether this channel currently enables the model.
           */
          const enabledByConfig = (id) => {
            if (disabled.includes(id)) return false
            if (allow.length === 0) return true
            return allow.includes(id)
          }
          /**
           * Switch state shown in the panel: the DRAFT when one exists, else the config.
           *
           * @param {string} id - model id within this channel.
           * @returns {boolean} the state to draw.
           */
          const shownOn = (id) => {
            const edited = draft === undefined ? undefined : draft.get(draftKey(channel.key, id))
            if (edited !== undefined) return edited
            return enabledByConfig(id)
          }
          const rows = ids.map((id) => {
            const state = shownOn(id)
            return {
              id,
              name: names.get(id) ?? id,
              on: state,
              // `reported` = the Host still advertises it, which means it is CURRENTLY
              // enabled upstream. A deliberately disabled model is absent for that reason,
              // not because it went missing, so it must not carry the "not reported" tag.
              reported: advertised.has(id) || disabled.includes(id) || state !== enabledByConfig(id),
            }
          })
          // A channel with no catalogue group is not registered under the current
          // `transport`. Its config lists may still name models (a leftover from when it WAS
          // registered), but those are not "models this plugin serves" — drawing them is
          // exactly the reported defect: fifteen greyed-out agent-era ids standing in for the
          // four models actually being served. Report the count, contribute no rows.
          return {
            key: channel.key,
            provider: channel.provider,
            name: channel.name,
            enabledField: channel.enabledField,
            disabledField: channel.disabledField,
            registered: group !== undefined,
            advertised: advertised.size,
            rows: group === undefined ? [] : rows,
            enabled: group === undefined ? 0 : rows.filter((/** @type {any} */ row) => row.on === true).length,
            total: group === undefined ? 0 : rows.length,
            /** @param {string} id @returns {boolean} */
            enabledByConfig,
            /** @returns {boolean} whether this channel's draft differs from the saved document. */
            dirty: () => {
              if (group === undefined) return false
              if (clearAll.has(channel.key)) return disabled.length !== 0 || allow.length !== 0
              if (draft === undefined) return false
              for (const [key, on] of draft) {
                if (!key.startsWith(`${channel.key}\u0000`)) continue
                const id = key.slice(channel.key.length + 1)
                if (on !== enabledByConfig(id)) return true
              }
              return false
            },
            clearAll: () => clearAll.has(channel.key),
            disabled,
            allow,
          }
        }

        const sections = CHANNELS.map((channel) => sectionFor(channel))
        // Keep an unregistered channel in the list when the config still names models for it:
        // that is the honest "this transport does not serve these leftovers" case, and saying
        // so beats silently omitting the channel. An unregistered channel never contributes
        // rows, so the stale ids cannot inflate the counter.
        const visibleSections = sections.filter((section) => (
          section.registered || section.disabled.length !== 0 || section.allow.length !== 0
        ))
        const allRows = visibleSections.flatMap((section) => section.rows)
        /** @type {string} */
        let status = "ready"
        /** @type {string | null} */
        let error = null
        if (catalogStatus === "error") {
          status = "error"
          error = catalogError
        } else if (catalogStatus === "loading") {
          status = "loading"
        } else if (config === undefined) {
          // The settings mirror has not delivered this namespace yet. That is a normal
          // start-up state (the panel mounts before `settings.describe` answers), not a
          // failure: `whileServed` in start() binds the controller as soon as it arrives.
          // Showing a banner here was the reported defect -- a permanently red card on a
          // perfectly healthy install.
          status = "loading"
        } else if (config.status === "loading") {
          status = "loading"
        } else if (config.status === "unavailable") {
          status = "unavailable"
        } else if (allRows.length === 0) {
          status = "empty"
        }
        // The plan channel's route mode is a structural setting this card only reports:
        // flipping it changes the model ids themselves, which is a config-file decision.
        const routeMode = typeof value.planRouteMode === "string" && value.planRouteMode !== "" ? value.planRouteMode : "merged"
        const pinned = idList(value.planPinnedRoutes)
        const transport = typeof value.transport === "string" && value.transport !== "" ? value.transport : "plan"
        snapshot = {
          status,
          sections: visibleSections,
          rows: allRows,
          enabled: allRows.filter((/** @type {any} */ row) => row.on === true).length,
          total: allRows.length,
          routeMode,
          pinnedCount: pinned.length,
          transport,
          writable: config !== undefined && config.writable === true,
          bound: controller !== undefined && boundNamespace !== undefined,
          boundNamespace,
          served: servedNamespaces(),
          // Draft state drives the Save / Discard pair, exactly like the shipped connector:
          // edits are local until saved, and the buttons say which of the two is meaningful.
          dirty: visibleSections.some((section) => section.dirty()),
          saving,
          error,
          writeError,
          writing,
        }
        for (const listener of [...listeners]) listener()
      }

      /** Re-read the advertised catalogue from the Host. @returns {Promise<void>} */
      const reload = async () => {
        if (disposed) return
        catalogStatus = "loading"
        publish()
        try {
          if (sessionRemote === undefined || typeof sessionRemote.modelCatalog !== "function") {
            throw new Error("remote.session.modelCatalog is unavailable")
          }
          const response = await sessionRemote.modelCatalog()
          if (response === null || typeof response !== "object" || response.ok !== true) {
            const message = response !== null && typeof response === "object" && response.error !== undefined && response.error !== null
              ? String(response.error.message ?? response.error)
              : "modelCatalog failed"
            throw new Error(message)
          }
          const payload = response.value
          groups = payload !== null && typeof payload === "object" && Array.isArray(payload.groups) ? payload.groups : []
          catalogStatus = "ready"
          catalogError = null
        } catch (/** @type {any} */ error) {
          catalogStatus = "error"
          catalogError = error instanceof Error ? error.message : String(error)
        }
        publish()
      }

      /**
       * Apply one atomic config mutation and refresh the advertised list.
       *
       * @param {any[]} ops - ordered path operations for the settings namespace.
       * @returns {Promise<boolean>} whether the Host accepted the write.
       */
      const write = async (ops) => {
        if (controller === undefined) return false
        writing = true
        writeError = null
        publish()
        let accepted = false
        try {
          if (typeof controller.mutate === "function") {
            accepted = await controller.mutate(ops)
          } else if (typeof controller.set === "function") {
            // Older settings lines expose only per-field writes; apply the ops in
            // order and report the first refusal, exactly as a batch would.
            accepted = true
            for (const op of ops) {
              if (await controller.set(op.path[0], op.value) !== true) {
                accepted = false
                break
              }
            }
          }
        } catch (/** @type {any} */ error) {
          accepted = false
          writeError = error instanceof Error ? error.message : String(error)
        }
        writing = false
        if (!accepted) {
          writeError = writeError ?? "rejected"
          publish()
          return false
        }
        await reload()
        return true
      }

      /**
       * Turn one model on or off in the DRAFT.
       *
       * No write, no catalogue re-read: the panel redraws from local state, which is what
       * stops the list going grey under the click. `save()` turns the draft into one
       * atomic config mutation.
       *
       * @param {string} channelKey - which channel's switch (`plan` / `cli`).
       * @param {string} id - model id within that channel.
       * @param {boolean} on - requested state.
       * @returns {Promise<void>}
       */
      const setModel = async (channelKey, id, on) => {
        if (disposed || controller === undefined || saving) return
        if (draft === undefined) draft = new Map()
        // Record the requested state only; `save()` reconciles each channel's two lists
        // once, so a burst of clicks can never produce two writes that disagree.
        draft.set(draftKey(channelKey, id), on === true)
        publish()
      }

      /**
       * Draft every known model of ONE channel as enabled, without writing.
       *
       * An empty pair of lists IS "everything enabled" for that channel, so this draft is
       * expressible without naming ids.
       *
       * @param {string} channelKey - which channel to clear (`plan` / `cli`).
       * @returns {Promise<void>}
       */
      const enableAll = async (channelKey) => {
        if (disposed || controller === undefined || saving) return
        clearAll.add(channelKey)
        publish()
      }

      /** Throw away unsaved edits. @returns {void} */
      const discard = () => {
        if (saving) return
        draft = undefined
        clearAll = new Set()
        writeError = null
        publish()
      }

      /**
       * Commit the draft as ONE ordered config mutation.
       *
       * Each channel's two lists are reconciled together from the saved document plus the
       * draft, so the fields can never end up describing contradictory sets, and exactly
       * one write (and therefore one catalogue re-read) happens per save.
       *
       * @returns {Promise<void>}
       */
      const save = async () => {
        if (disposed || controller === undefined || saving) return
        if (draft === undefined && clearAll.size === 0) return
        const config = controller.getSnapshot()
        const value = config.value === null || config.value === undefined ? {} : config.value

        /** @type {any[]} */
        const ops = []
        // Reconcile each channel against ITS OWN two fields. A shared pass would let one
        // channel's click land in the other channel's list, which is precisely the class of
        // bug this whole rework removes.
        for (const channel of CHANNELS) {
          const savedDisabled = idList(value[channel.disabledField])
          const savedAllow = idList(value[channel.enabledField])
          /** @type {string[]} */
          let nextDisabled = [...savedDisabled]
          /** @type {string[]} */
          let nextAllow = [...savedAllow]

          if (clearAll.has(channel.key)) {
            nextDisabled = []
            nextAllow = []
          } else if (draft !== undefined) {
            for (const [key, on] of draft) {
              if (!key.startsWith(`${channel.key}\u0000`)) continue
              const id = key.slice(channel.key.length + 1)
              if (on === false) {
                // Off always lands in the disabled list: the Host applies it last, so it
                // wins over any allow list.
                if (!nextDisabled.includes(id)) nextDisabled.push(id)
                continue
              }
              nextDisabled = nextDisabled.filter((entry) => entry !== id)
              // An explicit allow list is in force: a model switched back on must be in it,
              // or the two fields disagree and the model stays hidden.
              if (nextAllow.length > 0 && !nextAllow.includes(id)) nextAllow.push(id)
            }
          }

          if (nextDisabled.join("\u0000") !== savedDisabled.join("\u0000")) {
            ops.push({ op: "set", path: [channel.disabledField], value: nextDisabled })
          }
          if (nextAllow.join("\u0000") !== savedAllow.join("\u0000")) {
            ops.push({ op: "set", path: [channel.enabledField], value: nextAllow })
          }
        }
        if (ops.length === 0) {
          // Nothing actually changed (a click that landed back on the saved state).
          discard()
          return
        }

        saving = true
        publish()
        const ok = await write(ops)
        saving = false
        if (ok) {
          draft = undefined
          clearAll = new Set()
        }
        publish()
      }

      /**
       * Bind the settings service and start the first catalogue read.
       *
       * The config form is NOT available the moment the panel mounts: `configForms.get(ns)`
       * returns a controller only once the Host serves that namespace, and this panel mounts
       * before `settings.describe` has answered. Calling it once at mount therefore left
       * `controller` undefined forever — which is exactly the "插件配置当前不可用" banner this
       * replaces. `configForms.whileServed(namespaces, register)` is the shipped primitive
       * for this: it fires as soon as one of the namespaces appears, hands back the served
       * set, and re-fires on settings revisions. dsh-connect-workbuddy binds its cards the
       * same way.
       *
       * @returns {void}
       */
      const start = () => {
        forms = ctx.get("configForms")
        const remote = ctx.get("remote")
        sessionRemote = ctx.get("remote.session") ?? (remote === undefined || remote === null ? undefined : remote.session)

        /**
         * Adopt a controller if one is available right now.
         *
         * `served` is the authority: a namespace that is absent from the describe mirror
         * has no form, and `forms.get()` would fabricate an `unavailable` one for it. When
         * the mirror has not answered yet, binding is DEFERRED to `whileServed` rather than
         * guessed — that guess is the defect this replaces.
         *
         * @returns {boolean} whether a controller is bound.
         */
        const bindNow = () => {
          if (forms === undefined || forms === null || typeof forms.get !== "function") return false
          const served = servedNamespaces()
          const target = resolveServedNamespace(served)
          if (target !== undefined) {
            boundNamespace = target
            try {
              adopt(forms.get(target))
              return true
            } catch (/** @type {any} */ error) {
              console.error(`[dsh-connect-zcode] config form "${target}" could not be adopted:`, error)
              return false
            }
          }
          if (served.length === 0 && typeof forms.whileServed !== "function") {
            // A settings line without the describe mirror (very old): there is nothing to
            // ask, so the declared name is the only option left.
            boundNamespace = SETTINGS_NS
            adopt(forms.get(SETTINGS_NS))
            return true
          }
          return false
        }

        if (!bindNow() && forms !== undefined && forms !== null
          && typeof forms.whileServed === "function" && typeof ctx.effect === "function") {
          ctx.effect(() => forms.whileServed(SETTINGS_NS_CANDIDATES, (/** @type {Set<string> | undefined} */ served) => {
            const list = served instanceof Set ? [...served] : []
            // Prefer a candidate spelling, then anything zcode-shaped on a host that
            // renamed the entry beyond recognition.
            const ns = resolveServedNamespace(list)
            if (ns !== undefined) {
              boundNamespace = ns
              try {
                const next = forms.get(ns)
                if (next !== undefined && next !== null) adopt(next)
              } catch (/** @type {any} */ error) {
                console.error("[dsh-connect-zcode] config form binding failed after settings arrived:", error)
              }
            }
            return () => {
              if (typeof unsubscribe === "function") unsubscribe()
              unsubscribe = undefined
            }
          }), "dsh-connect-zcode: settings namespace binding")
        }
        void reload()
      }

      /**
       * Take ownership of one config controller and republish on its changes.
       *
       * @param {any} next Controller from `configForms.get`.
       * @returns {void}
       */
      const adopt = (next) => {
        if (next === controller) return
        if (typeof unsubscribe === "function") unsubscribe()
        controller = next
        unsubscribe = typeof controller.subscribe === "function" ? controller.subscribe(() => publish()) : undefined
        publish()
      }

      /** Release subscriptions. @returns {void} */
      const dispose = () => {
        disposed = true
        if (typeof unsubscribe === "function") unsubscribe()
        unsubscribe = undefined
        listeners.clear()
      }

      return {
        /** @param {() => void} listener @returns {() => void} */
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** @returns {any} */
        getSnapshot: () => snapshot,
        start,
        dispose,
        setModel,
        enableAll,
        save,
        discard,
        reload,
      }
    }

    // ── components ────────────────────────────────────────────────────────────

    /**
     * One channel's section: heading, diagnostics strip, and one switch per model.
     *
     * The card draws a section per registered channel rather than one flat list, because
     * the two channels own different config fields and can legitimately list the same model
     * id. A single list could not say which channel a switch writes to — and when the
     * direct channel became the default, that ambiguity is what left the panel showing
     * fifteen stale agent-era ids and zero switches for the models actually served.
     *
     * @param {any} props - `{ t, section, controlsDisabled, busy, onToggle, onEnableAll }`.
     * @returns {any} the element.
     */
    function ChannelSection(props) {
      const { t, section, controlsDisabled, busy } = props
      /** @type {any[]} */
      const children = [
        h(
          "div",
          { className: "zcp-sec-head", key: "head" },
          h("h2", { className: "zcp-sec-title" }, t(section.key === "plan" ? "channelPlan" : "channelCli")),
          h("span", { className: "zcp-count" }, t("enabledCount", { n: section.enabled, total: section.total })),
          h(
            "div",
            { className: "zcp-actions" },
            h(Button, {
              key: "all",
              variant: "outline",
              size: "sm",
              disabled: controlsDisabled || section.rows.length === 0,
              onClick: () => props.onEnableAll(section.key),
            }, t("enableAll")),
          ),
        ),
        h("p", { className: "zcp-intro", key: "hint" }, t(section.key === "plan" ? "channelPlanHint" : "channelCliHint")),
        // Diagnostics strip, mirroring the sibling connectors' `diag*` rows: the provider id
        // is the single most useful fact when a card looks wrong, and it was previously
        // printed once for a hard-coded provider that might not even be registered.
        h(
          "p",
          { className: "zcp-diag", key: "diag" },
          h("span", null, `${t("diagProvider")} ${section.provider}`),
          h("span", null, `${t("diagCatalog")} ${section.registered ? section.advertised : t("diagNotReported")}`),
          h("span", null, `${t("diagEnabled")} ${section.enabled}`),
        ),
      ]

      if (!section.registered) {
        children.push(h("p", { className: "zcp-banner", key: "off", "data-tone": "warn" }, t("channelOff", { transport: props.transport })))
        return h("section", { className: "zcp-sec", key: section.key }, children)
      }
      if (section.rows.length === 0) {
        children.push(h("p", { className: "zcp-muted", key: "empty" }, t("channelEmpty")))
        return h("section", { className: "zcp-sec", key: section.key }, children)
      }

      children.push(
        h(
          "ul",
          { className: "zcp-list", key: "list" },
          section.rows.map((/** @type {any} */ row) =>
            h(
              "li",
              { className: "zcp-row", key: row.id },
              h(Checkbox, {
                className: "zcp-check",
                checked: row.on === true,
                disabled: controlsDisabled,
                label: row.name,
                onChange: (/** @type {boolean} */ next) => props.onToggle(section.key, row.id, next),
              }),
              row.name === row.id ? null : h("span", { className: "zcp-id" }, row.id),
              row.reported === true ? null : h(Tag, { tone: "quiet" }, t("notReported")),
            ),
          ),
        ),
      )
      return h("section", { className: "zcp-sec", key: section.key }, children)
    }

    /**
     * The plugin-page card: one section per registered channel, plus the shared
     * Save / Discard pair.
     *
     * @param {any} props - injected `{ t, directory }`.
     * @returns {any} the element.
     */
    function ModelPanel(props) {
      const { t, directory } = props
      const snapshot = React.useSyncExternalStore(directory.subscribe, directory.getSnapshot)
      const rows = snapshot.rows
      const sections = Array.isArray(snapshot.sections) ? snapshot.sections : []
      const busy = snapshot.writing === true || snapshot.saving === true
      const dirty = snapshot.dirty === true
      // Accept edits as soon as a form is BOUND. The scope's own `writable` flag is not
      // the gate: on this host it stays false until the mirror settles, and gating on it
      // left every switch dead on an otherwise healthy install.
      const controlsDisabled = busy || snapshot.bound !== true

      /** @type {any[]} */
      const children = [
        h(
          "div",
          { className: "zcp-head", key: "head" },
          h("h1", { className: "zcp-title" }, t("title")),
          h("span", { className: "zcp-count" }, t("enabledCount", { n: snapshot.enabled, total: snapshot.total })),
          h(
            "div",
            { className: "zcp-actions" },
            h(Button, { key: "retry", variant: "outline", size: "sm", disabled: busy, onClick: () => void directory.reload() }, t("retry")),
          ),
        ),
        h("p", { className: "zcp-intro", key: "intro" }, t("intro")),
      ]

      // The plan channel's route mode decides what the model ids even ARE (bare model ids in
      // merged mode, `<providerId>#<modelId>` in explicit mode), so it is worth stating on
      // the card — it is a config-file decision, not something this panel flips.
      if (snapshot.routeMode !== undefined) {
        const modeKey = snapshot.routeMode === "explicit" ? "routeModeExplicit" : "routeModeMerged"
        children.push(h(
          "p",
          { className: "zcp-diag", key: "mode" },
          h("span", null, `${t("diagMode")} ${t(modeKey)}`),
          snapshot.pinnedCount > 0 ? h("span", null, t("pinnedCount", { n: snapshot.pinnedCount })) : null,
        ))
      }

      if (snapshot.error !== null && snapshot.error !== undefined) {
        children.push(h("p", { className: "zcp-banner", key: "catalog-error", "data-tone": "error" }, t("catalogError", { message: snapshot.error })))
      }
      if (snapshot.status === "unavailable") {
        // Honest, actionable text: name the namespaces the Host really serves so a user
        // (or a bug report) can see the mismatch instead of a bare "unavailable".
        const served = Array.isArray(snapshot.served) && snapshot.served.length > 0
          ? snapshot.served.join(", ")
          : t("notReported")
        children.push(h("p", { className: "zcp-banner", key: "config-unavailable", "data-tone": "error" }, t("configUnavailable", { served })))
      }
      if (snapshot.writeError !== null && snapshot.writeError !== undefined) {
        children.push(h("p", { className: "zcp-banner", key: "write-error", "data-tone": "error" }, t("writeFailed", { message: snapshot.writeError })))
      }
      if (snapshot.status === "ready" && snapshot.bound === true && snapshot.writable !== true) {
        children.push(h("p", { className: "zcp-banner", key: "read-only", "data-tone": "warn" }, t("readOnly")))
      }

      if (snapshot.status === "loading" && rows.length === 0) {
        children.push(h("p", { className: "zcp-muted", key: "loading" }, t("loading")))
      } else if (rows.length === 0 && snapshot.status !== "loading") {
        children.push(h("p", { className: "zcp-muted", key: "empty" }, t("empty")))
      }

      // One section per channel. An unregistered channel is still rendered (with a notice)
      // so the card explains WHY its models are missing instead of silently omitting it.
      for (const section of sections) {
        children.push(h(ChannelSection, {
          key: `sec-${section.key}`,
          t,
          section,
          transport: snapshot.transport,
          controlsDisabled,
          busy,
          onToggle: (/** @type {string} */ channelKey, /** @type {string} */ id, /** @type {boolean} */ next) => void directory.setModel(channelKey, id, next),
          onEnableAll: (/** @type {string} */ channelKey) => void directory.enableAll(channelKey),
        }))
      }

      if (rows.length > 0) {
        // Save / Discard, mirroring the shipped connector: edits stay local until saved, so
        // toggling never re-reads (and therefore never blanks) the whole list.
        children.push(
          h(
            "div",
            { className: "zcp-save", key: "save" },
            dirty ? h("span", { className: "zcp-dirty" }, t("unsaved")) : h("span", { className: "zcp-muted" }, t("savedHint")),
            h(
              "div",
              { className: "zcp-actions" },
              h(Button, { key: "discard", variant: "outline", size: "sm", disabled: busy || !dirty, onClick: () => directory.discard() }, t("discard")),
              h(Button, { key: "save", variant: "primary", size: "sm", disabled: busy || !dirty, onClick: () => void directory.save() }, snapshot.saving === true ? t("saving") : t("save")),
            ),
          ),
        )
      }

      return h("section", { className: "zcp-root", "aria-label": t("title"), "data-testid": "dsh-connect-zcode-panel" }, children)
    }

    // ── plugin body ───────────────────────────────────────────────────────────

    /** Required client services; both are guaranteed on the Web line. */
    const inject = ["slots", "locale"]

    /**
     * Register the model-selection card inside the Plugins page.
     *
     * Where the panel lives is a product decision the Plugins page already answers: the
     * page renders one card per *bundle* (`plugins.bundle.config`, keyed by package name)
     * and one per declared *row* (`plugins.row.config`, keyed by `<pkg>#<rowId>`). Plugging
     * into those keeps the entry next to every other plugin's configuration instead of
     * adding another standalone icon to the left rail — the shipping connectors
     * (dsh-connect-workbuddy) register both keys for exactly this reason.
     *
     * Both slots are KEYED children of the Plugins page's own registration, so registering
     * before the page mounts is fine: `ctx.slots.inject` queues until the declaration
     * exists.
     *
     * @param {any} ctx - the browser plugin context.
     * @param {() => any} t - translator bound to this plugin's namespace.
     * @param {any} directory - the model directory controller.
     * @returns {void}
     */
    function registerPluginCards(ctx, t, directory) {
      /** @type {string[]} */
      const keys = [
        PACKAGE_NAME,
        `${PACKAGE_NAME}#${PACKAGE_NAME}`,
      ]
      for (const slotName of ["plugins.bundle.config", "plugins.row.config"]) {
        for (const key of keys) {
          try {
            ctx.slots.inject(slotName, () => ctx.slots.register({
              name: slotName,
              key,
              priority: 30,
              locale: NS,
              inject: () => ({ t, directory }),
            }, ModelPanel))
          } catch (error) {
            console.error(`[dsh-connect-zcode] ${slotName} (${key}) failed to register (host provider unaffected):`, error)
          }
        }
      }
    }

    /**
     * Register the plugin's configuration card in the Plugins page.
     *
     * @param {any} ctx - the browser plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-connect-zcode: panel copy")
        const t = ctx.locale.bind(NS)
        injectStyle()
        const directory = createDirectory(ctx)
        ctx.effect(() => () => directory.dispose(), "dsh-connect-zcode: model directory")
        directory.start()
        registerPluginCards(ctx, t, directory)
      } catch (error) {
        console.error("[dsh-connect-zcode] client panel failed to load (host provider unaffected):", error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = "dsh-connect-zcode-client"

    return module.exports
  },
});
