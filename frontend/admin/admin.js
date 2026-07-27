"use strict";

(() => {
  const MODEL_API_URL = "/api/admin/model-config";
  const PROGRESS_API_URL = "/api/admin/historical-progress";
  const PROGRESS_LABELS = {
    discovered: "已发现",
    fetched: "已抓取",
    analyzed: "已分析",
    verified: "已核对",
    ready: "预发布",
    published: "已发布"
  };
  const STAGE_LABELS = {
    discovered: "等待抓取",
    indexed: "目录已索引",
    needs_review: "等待核对",
    source_verified: "来源已核对",
    lifecycle_verified: "周期已核对",
    ready: "预发布",
    published: "已发布",
    manual_review: "人工复核",
    failed: "处理失败"
  };
  const REVIEW_LABELS = {
    verified: "已验证",
    partial: "部分兑现",
    ambiguous: "存在歧义",
    watching: "观察中"
  };
  const elements = {
    loginSection: document.getElementById("login-section"),
    loginForm: document.getElementById("login-form"),
    loginMessage: document.getElementById("login-message"),
    adminToken: document.getElementById("admin-token"),
    logoutButton: document.getElementById("logout-button"),
    workspace: document.getElementById("admin-workspace"),
    form: document.getElementById("model-config-form"),
    baseUrl: document.getElementById("model-base-url"),
    modelName: document.getElementById("model-name"),
    apiKey: document.getElementById("model-api-key"),
    apiKeyNote: document.getElementById("api-key-note"),
    endpointPreview: document.getElementById("endpoint-preview"),
    configStatus: document.getElementById("configuration-status"),
    configStatusText: document.getElementById("configuration-status-text"),
    configSource: document.getElementById("config-source"),
    keyStatus: document.getElementById("key-status"),
    updatedAt: document.getElementById("updated-at"),
    testButton: document.getElementById("test-button"),
    saveButton: document.getElementById("save-button"),
    resultBadge: document.getElementById("result-badge"),
    resultMessage: document.getElementById("result-message"),
    resultDetails: document.getElementById("result-details"),
    refreshProgress: document.getElementById("refresh-progress"),
    progressLiveStatus: document.getElementById("progress-live-status"),
    progressMetrics: document.getElementById("progress-metrics"),
    progressListEyebrow: document.getElementById("progress-list-eyebrow"),
    progressList: document.getElementById("progress-list"),
    progressEmpty: document.getElementById("progress-empty"),
    progressRange: document.getElementById("progress-range"),
    progressPage: document.getElementById("progress-page"),
    previousPage: document.getElementById("previous-page"),
    nextPage: document.getElementById("next-page"),
    progressSearchForm: document.getElementById("progress-search-form"),
    progressSearch: document.getElementById("progress-search"),
    queueTotal: document.getElementById("queue-total"),
    updatedLast24h: document.getElementById("updated-last-24h"),
    manualReviewCount: document.getElementById("manual-review-count"),
    retryCount: document.getElementById("retry-count"),
    rolloutStatus: document.getElementById("rollout-status"),
    coverageYears: document.getElementById("coverage-years")
  };

  let token = sessionStorage.getItem("policyAdminToken") || "";
  let progressGroup = "fetched";
  let progressPage = 1;
  let progressQuery = "";
  let progressTotalPages = 0;
  let progressTimer = null;
  let progressLoading = false;

  function refreshIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "stroke-width": 1.9 } });
  }

  async function apiRequest(url, method = "GET", body) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(payload.error?.message || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.details = payload.error?.details;
      throw error;
    }
    return payload.data;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }

  function sourceLabel(source) {
    if (source === "managed") return "后台托管";
    if (source === "environment") return "服务器环境";
    return "尚未配置";
  }

  function formatDate(value) {
    if (!value) return "环境变量配置";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
  }

  function endpointFor(value) {
    const base = String(value || "").trim().replace(/\/+$/, "");
    if (!base) return "等待填写接口地址";
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }

  function showWorkspace(config) {
    elements.loginSection.hidden = true;
    elements.workspace.hidden = false;
    elements.logoutButton.hidden = false;
    elements.baseUrl.value = config.baseUrl || "";
    elements.modelName.value = config.modelName || "";
    elements.apiKey.value = "";
    elements.endpointPreview.textContent = config.endpoint || endpointFor(config.baseUrl);
    elements.configSource.textContent = sourceLabel(config.source);
    elements.keyStatus.textContent = config.hasApiKey ? "已配置" : "未配置";
    elements.updatedAt.textContent = formatDate(config.updatedAt);
    elements.apiKeyNote.textContent = config.hasApiKey ? "当前密钥已保存；留空将继续使用" : "必须填写 API Key";
    elements.configStatus.classList.toggle("is-ready", Boolean(config.configured));
    elements.configStatus.classList.toggle("is-missing", !config.configured);
    elements.configStatusText.textContent = config.configured ? "参数完整" : "配置不完整";
  }

  function showLogin(message = "") {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = null;
    elements.workspace.hidden = true;
    elements.logoutButton.hidden = true;
    elements.loginSection.hidden = false;
    elements.loginMessage.textContent = message;
    elements.adminToken.value = "";
    elements.adminToken.focus();
  }

  function formPayload() {
    return {
      baseUrl: elements.baseUrl.value.trim(),
      modelName: elements.modelName.value.trim(),
      apiKey: elements.apiKey.value.trim()
    };
  }

  function setBusy(busy, action) {
    elements.testButton.disabled = busy;
    elements.saveButton.disabled = busy;
    if (!busy) {
      elements.testButton.querySelector("span").textContent = "测试连接";
      elements.saveButton.querySelector("span").textContent = "保存并启用";
      return;
    }
    const target = action === "save" ? elements.saveButton : elements.testButton;
    target.querySelector("span").textContent = action === "save" ? "正在验证并保存" : "正在检测";
  }

  function renderConnection(connection) {
    const ok = Boolean(connection?.ok);
    elements.resultBadge.className = `result-badge ${ok ? "is-success" : "is-error"}`;
    elements.resultBadge.textContent = ok ? "连接成功" : "连接失败";
    elements.resultMessage.textContent = connection?.message || "未获得检测结果";
    const details = [];
    if (Number.isFinite(connection?.status)) details.push(`HTTP ${connection.status}`);
    if (Number.isFinite(connection?.latencyMs)) details.push(`${connection.latencyMs} ms`);
    if (connection?.model) details.push(connection.model);
    if (connection?.testedAt) details.push(formatDate(connection.testedAt));
    elements.resultDetails.textContent = details.join(" · ") || connection?.category || "--";
  }

  function rolloutLabel(rollout) {
    if (rollout.mode === "full") return "全量发布";
    if (rollout.mode === "cohort") {
      return `首批 ${formatNumber(rollout.cohortReleased)} / ${formatNumber(rollout.targetSize)}`;
    }
    if (rollout.cohortStatus === "observing") return "首批观察中";
    return "关闭（等待审核）";
  }

  function analysisLabel(item) {
    if (!item.reviewStatus) return '<span class="muted-cell">尚未分析</span>';
    const confidence = item.confidence == null ? "" : ` · ${(item.confidence * 100).toFixed(0)}%`;
    const details = item.frameworkReady
      ? "研判框架已生成"
      : item.releaseEligible ? "等待研判框架" : "未通过发布门槛";
    return `<span class="review-chip review-${escapeHtml(item.reviewStatus)}">${escapeHtml(REVIEW_LABELS[item.reviewStatus] || item.reviewStatus)}${confidence}</span><small>${details}</small>`;
  }

  function renderProgress(data) {
    const { summary, selection, rollout } = data;
    for (const key of Object.keys(PROGRESS_LABELS)) {
      const metric = document.getElementById(`metric-${key}`);
      if (metric) metric.textContent = formatNumber(summary[key]);
    }
    elements.queueTotal.textContent = formatNumber(summary.queueTotal);
    elements.updatedLast24h.textContent = formatNumber(summary.updatedLast24h);
    elements.manualReviewCount.textContent = formatNumber(summary.manualReview);
    elements.retryCount.textContent = `${formatNumber(summary.failed)} / ${formatNumber(summary.scheduledRetry)}`;
    elements.rolloutStatus.textContent = rolloutLabel(rollout);
    elements.coverageYears.textContent = summary.earliestYear && summary.latestYear
      ? `${summary.earliestYear}-${summary.latestYear}` : "--";
    elements.progressListEyebrow.textContent = PROGRESS_LABELS[selection.group] || selection.group;
    elements.progressMetrics.querySelectorAll("[data-progress-group]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.progressGroup === selection.group);
    });

    elements.progressList.innerHTML = selection.items.map((item) => `
      <tr>
        <td class="policy-cell">
          <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
          <small>${item.sourceYear || "年份待核"} · ${escapeHtml(item.sourceName)}</small>
        </td>
        <td class="status-cell">
          <span class="stage-chip stage-${escapeHtml(item.stage)}">${escapeHtml(STAGE_LABELS[item.stage] || item.stage)}</span>
          ${item.lastError ? `<small class="error-text" title="${escapeHtml(item.lastError)}">${escapeHtml(item.lastError)}</small>` : ""}
        </td>
        <td class="analysis-cell">${analysisLabel(item)}</td>
        <td class="time-cell"><time datetime="${escapeHtml(item.updatedAt)}">${escapeHtml(formatDate(item.updatedAt))}</time><small>处理 ${formatNumber(item.attempts)} 次</small></td>
      </tr>
    `).join("");
    elements.progressEmpty.hidden = selection.items.length > 0;
    const start = selection.total ? (selection.page - 1) * selection.pageSize + 1 : 0;
    const end = Math.min(selection.page * selection.pageSize, selection.total);
    elements.progressRange.textContent = `显示 ${formatNumber(start)}-${formatNumber(end)}，共 ${formatNumber(selection.total)} 条`;
    progressTotalPages = selection.totalPages;
    elements.progressPage.textContent = selection.totalPages
      ? `${selection.page} / ${selection.totalPages}` : "0 / 0";
    elements.previousPage.disabled = selection.page <= 1;
    elements.nextPage.disabled = selection.page >= selection.totalPages;
    elements.progressLiveStatus.textContent = summary.latestUpdateAt
      ? `最近处理 ${formatDate(summary.latestUpdateAt)} · 15 秒刷新`
      : "暂无处理记录 · 15 秒刷新";
    refreshIcons();
  }

  async function loadProgress({ quiet = false } = {}) {
    if (progressLoading) return;
    progressLoading = true;
    if (!quiet) {
      elements.refreshProgress.disabled = true;
      elements.progressLiveStatus.textContent = "正在更新";
    }
    const params = new URLSearchParams({
      group: progressGroup,
      page: String(progressPage),
      pageSize: "20"
    });
    if (progressQuery) params.set("q", progressQuery);
    try {
      const data = await apiRequest(`${PROGRESS_API_URL}?${params}`);
      renderProgress(data);
    } catch (error) {
      elements.progressLiveStatus.textContent = `更新失败：${error.message}`;
      if (error.status === 401) showLogin("管理口令已失效，请重新登录");
    } finally {
      progressLoading = false;
      elements.refreshProgress.disabled = false;
    }
  }

  function startProgressRefresh() {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = window.setInterval(() => {
      if (!document.hidden) loadProgress({ quiet: true });
    }, 15_000);
  }

  async function loadConfiguration() {
    const config = await apiRequest(MODEL_API_URL);
    showWorkspace(config);
  }

  async function loadWorkspace() {
    await Promise.all([loadConfiguration(), loadProgress()]);
    startProgressRefresh();
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    token = elements.adminToken.value.trim();
    elements.loginMessage.textContent = "正在验证";
    try {
      await loadWorkspace();
      sessionStorage.setItem("policyAdminToken", token);
      elements.loginMessage.textContent = "";
    } catch (error) {
      token = "";
      sessionStorage.removeItem("policyAdminToken");
      showLogin(error.message);
    }
  });

  elements.logoutButton.addEventListener("click", () => {
    token = "";
    sessionStorage.removeItem("policyAdminToken");
    showLogin();
  });

  elements.refreshProgress.addEventListener("click", () => loadProgress());

  elements.progressMetrics.addEventListener("click", (event) => {
    const button = event.target.closest("[data-progress-group]");
    if (!button || button.dataset.progressGroup === progressGroup) return;
    progressGroup = button.dataset.progressGroup;
    progressPage = 1;
    loadProgress();
  });

  elements.progressSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    progressQuery = elements.progressSearch.value.trim();
    progressPage = 1;
    loadProgress();
  });

  elements.previousPage.addEventListener("click", () => {
    if (progressPage <= 1) return;
    progressPage -= 1;
    loadProgress();
  });

  elements.nextPage.addEventListener("click", () => {
    if (progressPage >= progressTotalPages) return;
    progressPage += 1;
    loadProgress();
  });

  elements.baseUrl.addEventListener("input", () => {
    elements.endpointPreview.textContent = endpointFor(elements.baseUrl.value);
  });

  elements.testButton.addEventListener("click", async () => {
    if (!elements.form.reportValidity()) return;
    setBusy(true, "test");
    try {
      const result = await apiRequest(MODEL_API_URL, "POST", formPayload());
      renderConnection(result.connection);
    } catch (error) {
      renderConnection(error.details?.connection || { ok: false, message: error.message });
      if (error.status === 401) showLogin("管理口令已失效，请重新登录");
    } finally {
      setBusy(false);
    }
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true, "save");
    try {
      const result = await apiRequest(MODEL_API_URL, "PUT", formPayload());
      renderConnection(result.connection);
      showWorkspace(result.config);
      elements.resultMessage.textContent = "连接测试通过，配置已保存并启用";
    } catch (error) {
      renderConnection(error.details?.connection || { ok: false, message: error.message });
      if (error.status === 401) showLogin("管理口令已失效，请重新登录");
    } finally {
      setBusy(false);
    }
  });

  document.querySelectorAll("[data-toggle-secret]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.toggleSecret);
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      const icon = button.querySelector("i, svg");
      if (icon) icon.setAttribute("data-lucide", visible ? "eye" : "eye-off");
      refreshIcons();
    });
  });

  refreshIcons();
  if (token) {
    loadWorkspace().catch(() => {
      token = "";
      sessionStorage.removeItem("policyAdminToken");
      showLogin("管理口令已失效，请重新登录");
    });
  } else {
    showLogin();
  }
})();
