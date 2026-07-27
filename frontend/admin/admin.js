"use strict";

(() => {
  const API_URL = "/api/admin/model-config";
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
    resultDetails: document.getElementById("result-details")
  };

  let token = sessionStorage.getItem("policyAdminToken") || "";

  function refreshIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "stroke-width": 1.9 } });
  }

  async function apiRequest(method, body) {
    const response = await fetch(API_URL, {
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

  async function loadConfiguration() {
    const config = await apiRequest("GET");
    showWorkspace(config);
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    token = elements.adminToken.value.trim();
    elements.loginMessage.textContent = "正在验证";
    try {
      await loadConfiguration();
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

  elements.baseUrl.addEventListener("input", () => {
    elements.endpointPreview.textContent = endpointFor(elements.baseUrl.value);
  });

  elements.testButton.addEventListener("click", async () => {
    if (!elements.form.reportValidity()) return;
    setBusy(true, "test");
    try {
      const result = await apiRequest("POST", formPayload());
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
      const result = await apiRequest("PUT", formPayload());
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
    loadConfiguration().catch(() => {
      token = "";
      sessionStorage.removeItem("policyAdminToken");
      showLogin("管理口令已失效，请重新登录");
    });
  } else {
    showLogin();
  }
})();
