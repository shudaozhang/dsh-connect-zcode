/**
 * Browser half of `dsh-connect-zcode`: the "zcode" global panel.
 *
 * A sidebar entry (`sidebar.panellist`) and the page it opens (`main`, keyed by
 * the same id) let the user pick which ZCode models the Host advertises. Every
 * switch writes this plugin's own config section, so the adapter's existing
 * `enabledModelIds` / `disabledModelIds` filter is the only thing that has to
 * change on the Host side.
 *
 * Why this shape:
 * - The bundle is served as a classic script and must register itself through
 *   `window.__ModuleLoader__.load({ id, factory })`; the file therefore holds no
 *   top-level declarations at all (combo scripts are concatenated) and no
 *   `import`/`export` statements (they would not parse as a classic script).
 * - `apply`/`inject`/`name` are the plugin body, mirroring the shipped client
 *   halves (`@deepseek-ai/dsh-client-ui-schedule` registers the same pair of
 *   slots for its 自动化任务 panel).
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
    /** Panel id: one string addresses both the sidebar row and the `main` panel. */
    const PANEL_ID = "dsh-connect-zcode"
    /** Provider route id registered by the Host half (`lib/index.js`). */
    const PROVIDER = "zcode-cli"
    /** Provider display name the Host registers for that route. */
    const PROVIDER_NAME = "zcode"
    /** Locale namespace owned by this plugin. */
    const NS = "settings.zcode"
    /** Stable `<style>` identity so a reload replaces rather than stacks copies. */
    const STYLE_ID = "dsh-connect-zcode/panel.css"

    // ── copy ──────────────────────────────────────────────────────────────────

    /** Simplified Chinese copy (key-set source of truth). */
    const zh = {
      panel: "zcode",
      title: "zcode 模型",
      intro: "选择要在 DSH 模型选择器中出现的 ZCode 模型。每次切换都会立即写入插件配置。",
      providerLine: "供应商 {name}（{id}）",
      enabledCount: "已启用 {n}/{total}",
      enableAll: "全部启用",
      retry: "重新读取",
      loading: "正在读取模型目录…",
      empty: "没有读取到任何 zcode 模型。ZCode 桌面客户端可能未安装、未登录，或供应商尚未注册。",
      catalogError: "读取模型目录失败：{message}",
      configUnavailable: "插件配置当前不可用——请确认 dsh-connect-zcode 已在插件列表中启用。",
      readOnly: "当前部署的插件配置为只读，改动无法保存。",
      writeFailed: "保存失败，配置已回滚到宿主状态。",
      notReported: "未上报",
    }

    /** English copy. */
    const en = {
      panel: "zcode",
      title: "zcode models",
      intro: "Choose which ZCode models the model picker offers. Every switch is written to the plugin config immediately.",
      providerLine: "Provider {name} ({id})",
      enabledCount: "{n} of {total} enabled",
      enableAll: "Enable all",
      retry: "Reload",
      loading: "Reading the model catalogue…",
      empty: "No zcode model was reported. The ZCode desktop client may be missing or signed out, or the provider is not registered.",
      catalogError: "Could not read the model catalogue: {message}",
      configUnavailable: "This plugin's config is unavailable — make sure dsh-connect-zcode is enabled in the plugin list.",
      readOnly: "This deployment serves the plugin config read-only, so changes cannot be saved.",
      writeFailed: "Saving failed; the config was rolled back to the Host state.",
      notReported: "not reported",
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
     * @returns {any} `{ subscribe, getSnapshot, start, dispose, setModel, enableAll, reload }`.
     */
    function createDirectory(ctx) {
      /** @type {Set<() => void>} */
      const listeners = new Set()
      /** @type {any} */
      let snapshot = { status: "loading", rows: [], enabled: 0, total: 0, writable: false, error: null, writeError: null, writing: false }
      /** @type {any} */
      let controller
      /** @type {any} */
      let sessionRemote
      /** @type {any[]} */
      let groups = []
      let catalogStatus = "loading"
      /** @type {string | null} */
      let catalogError = null
      /** @type {Map<string, boolean>} */
      const pending = new Map()
      let writing = false
      /** @type {string | null} */
      let writeError = null
      let disposed = false
      /** @type {(() => void) | undefined} */
      let unsubscribe

      /** @returns {void} */
      const publish = () => {
        if (disposed) return
        const config = controller === undefined ? undefined : controller.getSnapshot()
        const value = config === undefined || config.value === null || config.value === undefined ? {} : config.value
        const disabled = idList(value.disabledModelIds)
        const allow = idList(value.enabledModelIds)
        const group = groups.find((/** @type {any} */ candidate) => candidate !== null && typeof candidate === "object" && candidate.id === PROVIDER)
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
        const rows = ids.map((id) => {
          const override = pending.get(id)
          return {
            id,
            name: names.get(id) ?? id,
            on: override === undefined ? advertised.has(id) : override,
            reported: advertised.has(id),
          }
        })
        /** @type {string} */
        let status = "ready"
        /** @type {string | null} */
        let error = null
        if (catalogStatus === "error") {
          status = "error"
          error = catalogError
        } else if (catalogStatus === "loading" || config === undefined || config.status === "loading") {
          status = "loading"
        } else if (config.status === "unavailable") {
          status = "unavailable"
        } else if (rows.length === 0) {
          status = "empty"
        }
        snapshot = {
          status,
          rows,
          enabled: rows.filter((/** @type {any} */ row) => row.on === true).length,
          total: rows.length,
          writable: config !== undefined && config.writable === true,
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
        pending.clear()
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
          pending.clear()
          publish()
          return false
        }
        await reload()
        return true
      }

      /**
       * Turn one model on or off.
       *
       * Off always lands as an entry in `disabledModelIds`, which the Host applies
       * last and therefore wins over any allow list. On clears that entry and, when
       * the user layer carries an explicit allow list, adds the id to it so the two
       * fields can never disagree.
       *
       * @param {string} id - CLI model id.
       * @param {boolean} on - requested state.
       * @returns {Promise<void>}
       */
      const setModel = async (id, on) => {
        if (disposed || controller === undefined) return
        const config = controller.getSnapshot()
        const value = config.value === null || config.value === undefined ? {} : config.value
        const disabled = idList(value.disabledModelIds)
        const allow = idList(value.enabledModelIds)
        /** @type {any[]} */
        const ops = []
        if (on === true) {
          if (disabled.includes(id)) {
            ops.push({ op: "set", path: ["disabledModelIds"], value: disabled.filter((/** @type {string} */ entry) => entry !== id) })
          }
          if (allow.length > 0 && !allow.includes(id)) {
            ops.push({ op: "set", path: ["enabledModelIds"], value: [...allow, id] })
          }
        } else if (!disabled.includes(id)) {
          ops.push({ op: "set", path: ["disabledModelIds"], value: [...disabled, id] })
        }
        if (ops.length === 0) return
        pending.set(id, on)
        publish()
        await write(ops)
      }

      /** Clear both lists, restoring the "everything enabled" default. @returns {Promise<void>} */
      const enableAll = async () => {
        if (disposed || controller === undefined) return
        const config = controller.getSnapshot()
        const value = config.value === null || config.value === undefined ? {} : config.value
        if (idList(value.enabledModelIds).length === 0 && idList(value.disabledModelIds).length === 0) return
        pending.clear()
        await write([
          { op: "set", path: ["enabledModelIds"], value: [] },
          { op: "set", path: ["disabledModelIds"], value: [] },
        ])
      }

      /** Bind the settings service and start the first catalogue read. @returns {void} */
      const start = () => {
        const forms = ctx.get("configForms")
        const remote = ctx.get("remote")
        sessionRemote = ctx.get("remote.session") ?? (remote === undefined || remote === null ? undefined : remote.session)
        if (forms !== undefined && forms !== null && typeof forms.get === "function") {
          try {
            controller = forms.get(SETTINGS_NS)
            if (typeof controller.subscribe === "function") unsubscribe = controller.subscribe(() => publish())
          } catch (/** @type {any} */ error) {
            console.error("[dsh-connect-zcode] config form unavailable (panel stays read-only):", error)
            controller = undefined
          }
        }
        void reload()
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
        reload,
      }
    }

    // ── components ────────────────────────────────────────────────────────────

    /**
     * Sidebar glyph: a rounded chip with a bolt, drawn with `currentColor` so it
     * inherits the row's active/idle colour.
     *
     * @param {any} props - `size` from the sidebar, `active` when selected.
     * @returns {any} the element.
     */
    function PanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 18
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
        h("rect", { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2.6, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", {
          d: "M8.7 4.9 6.3 8.3h1.9L7.3 11.1l2.5-3.5H7.9l.8-2.7Z",
          fill: "currentColor",
        }),
      )
    }

    /**
     * The `main` panel: provider name, enabled counter, one switch per model, and
     * the "全部启用" reset.
     *
     * @param {any} props - injected `{ t, directory }`.
     * @returns {any} the element.
     */
    function ModelPanel(props) {
      const { t, directory } = props
      const snapshot = React.useSyncExternalStore(directory.subscribe, directory.getSnapshot)
      const rows = snapshot.rows
      const busy = snapshot.writing === true
      const controlsDisabled = busy || snapshot.writable !== true

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
            h(Button, { key: "all", variant: "outline", size: "sm", disabled: controlsDisabled, onClick: () => void directory.enableAll() }, t("enableAll")),
            h(Button, { key: "retry", variant: "outline", size: "sm", disabled: busy, onClick: () => void directory.reload() }, t("retry")),
          ),
        ),
        h("p", { className: "zcp-intro", key: "intro" }, t("intro")),
        h("p", { className: "zcp-intro", key: "provider" }, t("providerLine", { name: PROVIDER_NAME, id: PROVIDER })),
      ]

      if (snapshot.error !== null && snapshot.error !== undefined) {
        children.push(h("p", { className: "zcp-banner", key: "catalog-error", "data-tone": "error" }, t("catalogError", { message: snapshot.error })))
      }
      if (snapshot.status === "unavailable") {
        children.push(h("p", { className: "zcp-banner", key: "config-unavailable", "data-tone": "error" }, t("configUnavailable")))
      }
      if (snapshot.writeError !== null && snapshot.writeError !== undefined) {
        children.push(h("p", { className: "zcp-banner", key: "write-error", "data-tone": "error" }, t("writeFailed")))
      }
      if (snapshot.status === "ready" && snapshot.writable !== true) {
        children.push(h("p", { className: "zcp-banner", key: "read-only", "data-tone": "warn" }, t("readOnly")))
      }

      if (snapshot.status === "loading" && rows.length === 0) {
        children.push(h("p", { className: "zcp-muted", key: "loading" }, t("loading")))
      } else if (rows.length === 0 && snapshot.status !== "loading") {
        children.push(h("p", { className: "zcp-muted", key: "empty" }, t("empty")))
      }

      if (rows.length > 0) {
        children.push(
          h(
            "ul",
            { className: "zcp-list", key: "list" },
            rows.map((/** @type {any} */ row) =>
              h(
                "li",
                { className: "zcp-row", key: row.id },
                h(Checkbox, {
                  className: "zcp-check",
                  checked: row.on === true,
                  disabled: controlsDisabled,
                  label: row.name,
                  onChange: (/** @type {boolean} */ next) => void directory.setModel(row.id, next),
                }),
                row.name === row.id ? null : h("span", { className: "zcp-id" }, row.id),
                row.reported === true ? null : h(Tag, { tone: "quiet" }, t("notReported")),
              ),
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
     * Register the sidebar entry and its panel.
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
        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t, directory }),
        }, ModelPanel))
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t("panel"),
        }, PanelIcon))
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
