(() => {
  "use strict";

  const BASE_URL = new URL("./", document.baseURI);
  const STATUS_META = {
    verified: { label: "已验证", icon: "badge-check" },
    partial: { label: "部分兑现", icon: "circle-dot-dashed" },
    ambiguous: { label: "存在歧义", icon: "message-circle-warning" },
    watching: { label: "待观察", icon: "clock-3" },
    announced: { label: "仅表态/发文", icon: "megaphone" },
    observed: { label: "已观察到证据", icon: "eye" },
    confirmed: { label: "证据已确认", icon: "file-check-2" }
  };
  const REVIEW_STATUS_KEYS = Object.freeze(["verified", "partial", "ambiguous", "watching"]);
  const CURRENT_YEAR = new Date().getFullYear();
  const ARCHIVE_ERAS = Object.freeze([
    { key: "all", label: `1949—${CURRENT_YEAR}`, fromYear: 1949, toYear: CURRENT_YEAR },
    { key: "foundation", label: "1949—1977", fromYear: 1949, toYear: 1977 },
    { key: "reform", label: "1978—1999", fromYear: 1978, toYear: 1999 },
    { key: "integration", label: "2000—2012", fromYear: 2000, toYear: 2012 },
    { key: "modernization", label: "2013—2019", fromYear: 2013, toYear: 2019 },
    { key: "current", label: `2020—${CURRENT_YEAR}`, fromYear: 2020, toYear: CURRENT_YEAR }
  ]);

  const FALLBACK_IMAGE = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1800&q=82";
  const VISITOR_STORAGE_KEY = "policy-monitor-visitor-id";
  const FALLBACK_ARTICLES = [
    {
      id: "demo-renewal-2025",
      title: "设备更新支持边界扩大，政策执行重心转向申领体验",
      summary: "从政策表述到执行细则，真正影响落地速度的已不只是支持额度，而是企业能否以更低成本完成认定、申报和核验。",
      category: "产业政策",
      publishedAt: "2025-07-18T08:30:00+08:00",
      source: "政策监测演示信源",
      sourceUrl: "",
      heroImage: FALLBACK_IMAGE,
      imageCaption: "城市产业空间。当前为前端演示图片，正式数据由政策信源替换。",
      importance: "major",
      isFeatured: true,
      tags: ["设备更新", "产业投资", "执行细则"],
      readTime: 8,
      content: [
        "本轮政策的关键信号并非简单增加一项补助，而是把支持范围、申报门槛和核验方式放在同一条执行链路上。对企业而言，名义支持力度只有转化为可申领、可核验、可预测的规则，才会真正改变投资决策。",
        "与早期强调项目储备和资金投向相比，当前阶段更重视政策触达率与执行一致性。部分地区已开始缩短材料清单，但跨地区口径、设备认定周期以及财政资金拨付节奏仍需继续观察。",
        "后续判断不应只看已公布额度，还要跟踪申报通过率、平均兑现周期和企业新增订单。如果三项指标同步改善，才能确认政策从文件层进入了规模化落地阶段。"
      ],
      analysisLead: "支持范围正在扩大，但政策效果将由申报复杂度、地方配套节奏和资金兑现周期共同决定。",
      analysisVersion: 2,
      analysisHistory: [
        { version: 2, headline: "执行效率取代名义额度，成为政策效果的关键变量", evidenceSummary: "地方细则与企业反馈显示覆盖面扩大，但兑现周期仍存在差异。", status: "published", createdAt: "2025-07-18T08:30:00+08:00" },
        { version: 1, headline: "支持范围扩大有望带动新一轮设备投资", evidenceSummary: "首版判断主要依据政策原文，尚未获得地方申报与拨付数据。", status: "superseded", createdAt: "2025-01-16T09:00:00+08:00" }
      ],
      comparisons: [
        { dimension: "支持对象", previous: "以重点行业、重点项目清单为主", current: "覆盖更多中小企业和细分设备类型", implication: "政策触达面扩大，地方认定能力成为新的约束" },
        { dimension: "执行方式", previous: "先报项目、逐级审核，材料较多", current: "推动线上申报与并联核验", implication: "企业时间成本有望下降，但系统间数据协同仍需验证" },
        { dimension: "评估重点", previous: "关注资金下达与项目数量", current: "更强调投资增量和实际产出", implication: "后续考核可能从程序合规转向结果有效" }
      ],
      evidence: [
        { date: "2025-01-15", title: "政策方向公布", description: "明确扩大设备更新支持范围，并要求地方完善项目储备。", status: "verified", source: "公开文件", sourceUrl: "" },
        { date: "2025-03-28", title: "首批地方细则出现", description: "多地公布申报材料与核验流程，执行口径仍有差异。", status: "partial", source: "地方公开信息", sourceUrl: "" },
        { date: "2025-06-30", title: "企业端申报反馈增加", description: "部分流程缩短，但设备目录认定和资金拨付周期仍不稳定。", status: "ambiguous", source: "公开调研汇总", sourceUrl: "" },
        { date: "2025-09-30", title: "观察窗口", description: "重点验证通过率、拨付周期与新增设备订单能否同步改善。", status: "watching", source: "后续跟踪", sourceUrl: "" }
      ],
      review: {
        status: "partial",
        conclusion: "政策工具已经进入执行阶段，支持边界的扩大得到确认；但不同地区的兑现效率尚未形成稳定证据。",
        verifiedAt: "2025-07-18",
        confidence: "中等"
      },
      ambiguities: [
        { issue: "设备认定口径是否趋同", why: "地区目录与技术参数存在差异，可能造成同类项目待遇不同。", nextEvidence: "跨地区申报通过率与退回原因" },
        { issue: "资金兑现周期是否缩短", why: "文件提出提速，但目前缺少统一、连续的到账周期数据。", nextEvidence: "季度拨付进度与企业到账样本" }
      ],
      predictions: [
        { timeframe: "未来 1—2 个季度", signal: "申报材料继续精简", trigger: "若地方平台打通税务、项目和设备数据，重复证明材料将进一步减少。", confidence: "中等" },
        { timeframe: "下一轮政策窗口", signal: "考核转向产出效果", trigger: "若新增订单和产能利用率分化，后续资金可能更多与实际产出挂钩。", confidence: "中低" }
      ]
    },
    {
      id: "demo-consumption-2025",
      title: "消费支持进入效果核验期，补贴覆盖率之外还要看新增需求",
      summary: "短期交易数据已经改善，但政策是否带来真实增量，仍要剔除需求前置、品类替代和地区执行差异。",
      category: "消费民生",
      publishedAt: "2025-07-16T10:20:00+08:00",
      source: "政策监测演示信源",
      heroImage: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1400&q=80",
      importance: "high",
      tags: ["消费", "补贴", "效果评估"],
      status: "ambiguous",
      analysisLead: "交易放量已经出现，但尚不足以证明形成了等量的新增消费。",
      content: [
        "补贴政策进入中段后，评估重点需要从参与规模转向真实增量。单月交易额能够反映政策热度，却可能同时包含需求提前释放和品类之间的替代。",
        "更可靠的观察方法，是把补贴品类与未补贴品类、先行地区与后续地区放在同一时间窗口比较，并持续跟踪退货率、客单价和政策退出后的需求变化。"
      ],
      review: { status: "ambiguous", conclusion: "交易端有积极信号，但新增需求与需求前置仍难分离。", verifiedAt: "2025-07-16", confidence: "中等" }
    },
    {
      id: "demo-data-2025",
      title: "公共数据授权运营提速，定价与责任边界仍待统一",
      summary: "场景清单正在变长，真正决定可持续性的将是数据可用性、收益分配规则以及发生风险后的责任认定。",
      category: "数字经济",
      publishedAt: "2025-07-14T09:10:00+08:00",
      source: "政策监测演示信源",
      heroImage: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1400&q=80",
      importance: "normal",
      tags: ["公共数据", "授权运营", "数据要素"],
      status: "watching",
      analysisLead: "试点数量增加只是起点，标准化交付和责任闭环才是规模化前提。",
      content: [
        "公共数据授权运营正在从原则性制度走向场景化清单，但各地在数据产品形态、收费方式与运营主体选择上仍有较大差异。",
        "未来可重点观察跨地区复用的数据产品数量、实际调用频率以及争议处理机制。这些信号比挂牌数量更能说明数据要素是否形成稳定供给。"
      ],
      review: { status: "watching", conclusion: "制度框架正在形成，商业闭环与责任边界尚未经过充分验证。", verifiedAt: "2025-07-14", confidence: "中低" }
    },
    {
      id: "demo-housing-2025",
      title: "保障性住房配套规则补齐，项目去化与运营能力成为观察重点",
      summary: "供给端规则进一步明确，下一阶段应关注项目位置、租售需求匹配和长期运营成本。",
      category: "住房建设",
      publishedAt: "2025-07-11T14:40:00+08:00",
      source: "政策监测演示信源",
      heroImage: "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?auto=format&fit=crop&w=1400&q=80",
      importance: "normal",
      tags: ["保障房", "城市更新"],
      status: "partial",
      analysisLead: "建设进度逐步可见，长期运营和真实居住需求仍需用入住数据检验。",
      content: ["政策配套已逐步从土地和融资延伸到运营环节。后续需要把开工、交付、入住和运营成本放在同一条时间线上观察。"],
      review: { status: "partial", conclusion: "建设端已有进展，入住率与长期运营尚待验证。", verifiedAt: "2025-07-11", confidence: "中等" }
    },
    {
      id: "demo-employment-2025",
      title: "稳岗支持覆盖更多经营主体，政策触达已获初步验证",
      summary: "线上申领和免申即享扩大覆盖范围，公开数据开始显示政策触达改善。",
      category: "就业社保",
      publishedAt: "2025-07-09T08:50:00+08:00",
      source: "政策监测演示信源",
      heroImage: "https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1400&q=80",
      importance: "normal",
      tags: ["就业", "稳岗", "中小企业"],
      status: "verified",
      analysisLead: "政策触达改善已有连续证据，下一步要看岗位稳定是否能延续。",
      content: ["多地通过数据比对减少企业主动申报步骤，覆盖主体数量和资金到账速度均出现改善。对效果的进一步判断，需要继续跟踪参保人数和岗位持续时间。"],
      review: { status: "verified", conclusion: "申领便利度与触达率的改善已获得多期公开数据支持。", verifiedAt: "2025-07-09", confidence: "较高" }
    },
    {
      id: "demo-green-2025",
      title: "绿色项目评价口径调整，融资成本能否下降是下一验证点",
      summary: "目录和披露要求趋于统一，但标准变化能否传导到企业融资端仍需观察。",
      category: "绿色发展",
      publishedAt: "2025-07-05T11:00:00+08:00",
      source: "政策监测演示信源",
      heroImage: "https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?auto=format&fit=crop&w=1400&q=80",
      importance: "normal",
      tags: ["绿色金融", "信息披露"],
      status: "watching",
      analysisLead: "统一评价语言有助于降低识别成本，但融资价格仍取决于风险与收益证据。",
      content: ["评价目录与披露要求逐步靠拢，能够减少机构之间的识别差异。后续需要观察绿色项目的授信时间、利率差以及第三方核验成本。"],
      review: { status: "watching", conclusion: "评价规则趋于清晰，尚缺融资成本变化的连续证据。", verifiedAt: "2025-07-05", confidence: "中低" }
    }
  ];

  const state = {
    articles: [],
    archiveItems: [],
    archivePagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    archiveOverview: {
      total: 0,
      byStatus: { verified: 0, partial: 0, ambiguous: 0, watching: 0 },
      earliestYear: null,
      latestYear: null,
      requestedStartYear: 1949,
      requestedEndYear: CURRENT_YEAR,
      byDecade: []
    },
    archiveFilteredOverview: null,
    categories: [],
    siteViews: { total: null, today: null },
    usingFallback: false,
    query: "",
    category: "all",
    status: "all",
    era: "all",
    deferredInstallPrompt: null,
    routeVersion: 0
  };

  const audioState = {
    articleId: null,
    segments: [],
    segmentIndex: 0,
    segmentOffset: 0,
    absolutePosition: 0,
    rate: 1,
    isPlaying: false,
    utterance: null,
    token: 0,
    progressTimer: 0,
    segmentStartedAt: 0,
    segmentStartOffset: 0,
    lastBoundaryAt: 0,
    lastHighlightedIndex: -1
  };

  const viewedArticleIds = new Set();
  let visitorIdMemory = "";
  let siteViewRequest = null;

  const elements = {
    app: document.querySelector("#app"),
    loading: document.querySelector("#loading-screen"),
    searchDrawer: document.querySelector("#search-drawer"),
    searchInput: document.querySelector("#global-search"),
    mobileMenu: document.querySelector("#mobile-menu"),
    menuToggle: document.querySelector("#menu-toggle"),
    pushDialog: document.querySelector("#push-dialog"),
    enablePush: document.querySelector("#enable-push"),
    installApp: document.querySelector("#install-app"),
    deviceGuide: document.querySelector("#device-guide"),
    installButtons: [...document.querySelectorAll("#install-button, #mobile-install-button")],
    installDialog: document.querySelector("#install-dialog"),
    installDialogGuide: document.querySelector("#install-device-guide"),
    installDialogAction: document.querySelector("#install-dialog-action"),
    toast: document.querySelector("#toast")
  };

  function apiUrl(path) {
    return new URL(`api/${String(path).replace(/^\/+/, "")}`, BASE_URL).toString();
  }

  function assetUrl(path) {
    return new URL(String(path).replace(/^\/+/, ""), BASE_URL).toString();
  }

  function generateVisitorId(cryptoSource = window.crypto) {
    try {
      if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();
    } catch {
      // Fall through to a locally generated UUID.
    }

    const bytes = new Uint8Array(16);
    try {
      if (typeof cryptoSource?.getRandomValues === "function") cryptoSource.getRandomValues(bytes);
      else throw new Error("Secure random unavailable");
    } catch {
      const timestamp = Date.now();
      for (let index = 0; index < bytes.length; index += 1) {
        const timeByte = (timestamp >>> ((index % 6) * 8)) & 0xff;
        bytes[index] = timeByte ^ Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function isValidVisitorId(value) {
    return typeof value === "string" && /^[\x21-\x7e]{16,128}$/.test(value);
  }

  function readOrCreateVisitorId(storage, cryptoSource = window.crypto) {
    try {
      const stored = storage?.getItem(VISITOR_STORAGE_KEY);
      if (isValidVisitorId(stored)) return stored;
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }

    const visitorId = generateVisitorId(cryptoSource);
    try {
      storage?.setItem(VISITOR_STORAGE_KEY, visitorId);
    } catch {
      // The in-memory value still keeps requests stable for this page session.
    }
    return visitorId;
  }

  function getVisitorId() {
    if (!visitorIdMemory) visitorIdMemory = readOrCreateVisitorId(window.localStorage, window.crypto);
    return visitorIdMemory;
  }

  function normalizeViewNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function normalizeViews(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      total: normalizeViewNumber(source.total),
      today: normalizeViewNumber(source.today)
    };
  }

  function normalizeViewResponse(payload) {
    if (!payload || typeof payload !== "object") return { site: null, article: null };
    const article = payload.article && typeof payload.article === "object"
      ? { id: String(payload.article.id ?? ""), ...normalizeViews(payload.article) }
      : null;
    return {
      site: payload.site && typeof payload.site === "object" ? normalizeViews(payload.site) : null,
      article: article?.id ? article : null
    };
  }

  function mergeViews(current, incoming) {
    const existing = normalizeViews(current);
    if (!incoming) return existing;
    const next = normalizeViews(incoming);
    return {
      total: next.total ?? existing.total,
      today: next.today ?? existing.today
    };
  }

  function formatViewNumber(value) {
    const number = normalizeViewNumber(value);
    if (number == null) return "--";
    if (number >= 100000000) return `${Math.floor(number / 100000000)}亿+`;
    if (number >= 10000) return `${Math.floor(number / 10000)}万+`;
    return new Intl.NumberFormat("zh-CN").format(number);
  }

  function viewCountText(views) {
    const normalized = normalizeViews(views);
    return `总 ${formatViewNumber(normalized.total)} / 今日 ${formatViewNumber(normalized.today)}`;
  }

  function normalizeArticleViewId(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function createViewRequestBody(visitorId, articleId) {
    const body = { visitorId: String(visitorId || "") };
    const normalizedArticleId = normalizeArticleViewId(articleId);
    if (normalizedArticleId != null) body.articleId = normalizedArticleId;
    return body;
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeExternalUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, BASE_URL);
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function safeImageUrl(value) {
    if (!value) return FALLBACK_IMAGE;
    try {
      const url = new URL(value, BASE_URL);
      return ["http:", "https:", "data:"].includes(url.protocol) ? url.toString() : FALLBACK_IMAGE;
    } catch {
      return FALLBACK_IMAGE;
    }
  }

  function applyCoverImageFallback(image) {
    if (!image || !image.dataset || image.dataset.coverFallbackApplied === "true") return false;
    image.dataset.coverFallbackApplied = "true";
    const fallbackUrl = safeImageUrl(FALLBACK_IMAGE);
    const currentUrl = image.currentSrc || image.src || image.getAttribute?.("src") || "";
    if (currentUrl === fallbackUrl) return false;
    image.src = fallbackUrl;
    return true;
  }

  function handleCoverImageError(event) {
    applyCoverImageFallback(event.currentTarget);
  }

  function bindArticleCoverFallbacks(root = document) {
    if (!root?.querySelectorAll) return 0;
    let bound = 0;
    root.querySelectorAll("img[data-article-cover]").forEach((image) => {
      if (image.dataset.coverFallbackBound === "true") return;
      image.dataset.coverFallbackBound = "true";
      image.addEventListener("error", handleCoverImageError, { once: true });
      bound += 1;
      if (image.complete === true && Number(image.naturalWidth) === 0) applyCoverImageFallback(image);
    });
    return bound;
  }

  function statusKey(value) {
    const raw = String(value || "watching").toLowerCase().trim();
    const aliases = {
      "已验证": "verified",
      validated: "verified",
      complete: "verified",
      "部分兑现": "partial",
      partly: "partial",
      "存在歧义": "ambiguous",
      unclear: "ambiguous",
      "待观察": "watching",
      pending: "watching",
      watch: "watching",
      reversed: "ambiguous"
    };
    return STATUS_META[raw] ? raw : (aliases[raw] || "watching");
  }

  function normalizeList(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === "") return [];
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return value.split(/[，,、]/).map((item) => item.trim()).filter(Boolean);
      }
    }
    return [];
  }

  function normalizeFramework(value) {
    let framework = value;
    if (typeof framework === "string") {
      try {
        framework = JSON.parse(framework);
      } catch {
        framework = null;
      }
    }
    if (!framework || typeof framework !== "object" || Array.isArray(framework)) return null;
    return {
      ready: framework.ready === true,
      perspective: framework.perspective || "公共政策执行与实际影响",
      perspectiveNote: framework.perspectiveNote || framework.perspective_note || "",
      bottomLine: framework.bottomLine || framework.bottom_line || "",
      problem: framework.problem || framework.policyProblem || framework.policy_problem || "",
      tools: normalizeList(framework.tools || framework.policyTools || framework.policy_tools),
      affectedGroups: normalizeList(framework.affectedGroups || framework.affected_groups),
      executionPath: normalizeList(framework.executionPath || framework.execution_path),
      historicalChanges: normalizeList(framework.historicalChanges || framework.historical_changes),
      confirmed: normalizeList(framework.confirmed),
      unconfirmed: normalizeList(framework.unconfirmed)
    };
  }

  function normalizeSpeechText(value) {
    if (typeof value !== "string") return "";
    return value
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .split(/\n+/)
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function extractNarrationText(articleDetail) {
    if (!articleDetail || typeof articleDetail !== "object") return "";
    const source = [
      articleDetail.contentText,
      articleDetail.content_text,
      articleDetail.narrationText,
      articleDetail.narration_text
    ].find((value) => typeof value === "string" && value.trim());
    return normalizeSpeechText(source || "");
  }

  function splitLongSpeechUnit(value, maxLength) {
    const chunks = [];
    let remaining = value.trim();
    while (remaining.length > maxLength) {
      const windowText = remaining.slice(0, maxLength + 1);
      let cut = Math.max(
        windowText.lastIndexOf("，"),
        windowText.lastIndexOf("、"),
        windowText.lastIndexOf("："),
        windowText.lastIndexOf(","),
        windowText.lastIndexOf(":")
      );
      if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;
      else cut += 1;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  function segmentSpeechText(value, maxLength = 72) {
    const text = normalizeSpeechText(value);
    if (!text) return [];
    const limit = Math.max(40, Number(maxLength) || 120);
    const segments = [];
    let cursor = 0;

    text.split(/\n{2,}/).forEach((paragraph, paragraphIndex) => {
      const sentenceUnits = paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [paragraph];
      let buffer = "";
      const push = (part) => {
        const clean = part.trim();
        if (!clean) return;
        segments.push({
          text: clean,
          start: cursor,
          end: cursor + clean.length,
          paragraphIndex
        });
        cursor += clean.length;
      };

      sentenceUnits.forEach((unit) => {
        splitLongSpeechUnit(unit, limit).forEach((piece) => {
          if (buffer && buffer.length + piece.length > limit) {
            push(buffer);
            buffer = "";
          }
          buffer += piece;
          if (buffer.length >= limit) {
            push(buffer);
            buffer = "";
          }
        });
      });
      push(buffer);
    });

    return segments;
  }

  function findSpeechPosition(segments, absolutePosition) {
    if (!Array.isArray(segments) || !segments.length) return { index: 0, offset: 0 };
    const total = segments[segments.length - 1].end;
    const position = Math.max(0, Math.min(Number(absolutePosition) || 0, total));
    const index = segments.findIndex((segment) => position < segment.end);
    if (index === -1) {
      const lastIndex = segments.length - 1;
      return { index: lastIndex, offset: segments[lastIndex].text.length };
    }
    return { index, offset: Math.max(0, position - segments[index].start) };
  }

  function getAdjacentArticleIds(articles, articleId) {
    const index = articles.findIndex((article) => String(article.id) === String(articleId));
    return {
      previous: index > 0 ? String(articles[index - 1].id) : null,
      next: index >= 0 && index < articles.length - 1 ? String(articles[index + 1].id) : null
    };
  }

  function neighborArticleId(value) {
    if (value == null || value === "") return null;
    if (typeof value === "object") {
      const id = value.id ?? value.articleId ?? value.article_id;
      return id == null || id === "" ? null : String(id);
    }
    return String(value);
  }

  function normalizeArticle(raw, index = 0, options = {}) {
    const analysis = raw.analysis || raw.analysis_data || {};
    const review = raw.review || raw.retrospective || analysis.review || {};
    const reviewStatus = statusKey(raw.review_status || raw.reviewStatus || review.status || raw.landing_status || raw.status);
    const publishedAt = raw.published_at || raw.publishedAt || raw.publish_time || raw.publishDate || raw.date || new Date().toISOString();
    return {
      id: String(raw.id ?? raw.slug ?? `article-${index + 1}`),
      title: raw.title || raw.headline || "未命名政策分析",
      summary: raw.summary || raw.excerpt || raw.description || analysis.summary || "暂无摘要",
      category: raw.category_name || raw.category || raw.section || "综合政策",
      publishedAt,
      source: raw.source_name || raw.source || raw.department || "公开信源",
      sourceUrl: raw.sourceUrl || raw.source_url || raw.originalUrl || raw.original_url || raw.url || "",
      heroImage: raw.hero_image || raw.heroImage || raw.cover_image || raw.image || FALLBACK_IMAGE,
      imageCaption: raw.image_caption || raw.imageCaption || "",
      importance: raw.importance || raw.priority || (raw.featured ? "major" : "normal"),
      isFeatured: Boolean(raw.is_featured ?? raw.featured ?? raw.isFeatured),
      tags: normalizeList(raw.tags || raw.keywords),
      readTime: Number(raw.read_time || raw.readTime || 6),
      views: normalizeViews(raw.views),
      contentText: options.includeNarration === true ? extractNarrationText(raw) : "",
      content: raw.content || raw.body || raw.analysis_content || analysis.content || [],
      analysisLead: raw.analysis_lead || raw.analysisLead || raw.key_judgement || analysis.lead || raw.summary || "",
      analysisFramework: normalizeFramework(raw.analysis_framework || raw.analysisFramework || analysis.framework),
      analysisVersion: Number(raw.analysis_version || raw.analysisVersion || 0) || null,
      neighbors: raw.neighbors && typeof raw.neighbors === "object" ? raw.neighbors : null,
      analysisHistory: normalizeList(raw.analysis_history || raw.analysisHistory || analysis.history),
      assessmentSnapshots: normalizeList(raw.assessment_snapshots || raw.assessmentSnapshots || analysis.assessmentSnapshots),
      comparisons: normalizeList(raw.comparisons || raw.policy_comparisons || analysis.comparisons),
      evidence: normalizeList(raw.evidence || raw.evidence_timeline || raw.implementation_evidence || analysis.evidence),
      ambiguities: normalizeList(raw.ambiguities || raw.ambiguity_points || analysis.ambiguities),
      predictions: normalizeList(raw.predictions || raw.outlook || raw.forecasts || analysis.predictions),
      review: {
        status: reviewStatus,
        conclusion: review.conclusion || review.summary || raw.review_conclusion || raw.reviewConclusion || "尚待更多公开证据验证。",
        verifiedAt: review.verified_at || review.verifiedAt || raw.reviewed_at || raw.reviewedAt || publishedAt,
        confidence: review.confidence || raw.confidence || "待评估"
      }
    };
  }

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...(options.headers || {}) },
        ...options,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) throw new Error("API 未返回 JSON");
      return await response.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  function extractArticles(payload) {
    const source = Array.isArray(payload)
      ? payload
      : payload?.items || payload?.articles || payload?.data?.items || payload?.data || payload?.results || [];
    return Array.isArray(source) ? source.map(normalizeArticle) : [];
  }

  function extractPagination(payload) {
    const pagination = payload?.pagination || payload?.data?.pagination || {};
    const page = Number(pagination.page || 1);
    const pageSize = Number(pagination.pageSize || pagination.page_size || 25);
    const total = Number(pagination.total || 0);
    const totalPages = Number(pagination.totalPages || pagination.total_pages || 0);
    return {
      page: Number.isSafeInteger(page) && page > 0 ? page : 1,
      pageSize: Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 25,
      total: Number.isSafeInteger(total) && total >= 0 ? total : 0,
      totalPages: Number.isSafeInteger(totalPages) && totalPages >= 0 ? totalPages : 0
    };
  }

  async function fetchRecentArticles() {
    const pageSize = 50;
    const payload = await fetchJSON(apiUrl(`articles?page=1&pageSize=${pageSize}&fromYear=1949`));
    return extractArticles(payload);
  }

  function archiveEra(key = state.era) {
    return ARCHIVE_ERAS.find((item) => item.key === key) || ARCHIVE_ERAS[0];
  }

  function archiveQuery(mode, page = 1) {
    const era = archiveEra();
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "25",
      fromYear: String(era.fromYear),
      toYear: String(era.toYear)
    });
    if (state.query) params.set("q", state.query);
    if (state.category !== "all") params.set("category", state.category);
    if (state.status !== "all") params.set("reviewStatus", state.status);
    if (mode === "outlook") params.set("hasForecast", "1");
    return params;
  }

  async function fetchArchivePage(mode, page = 1) {
    const query = archiveQuery(mode, page);
    const overviewQuery = new URLSearchParams(query);
    overviewQuery.delete("page");
    overviewQuery.delete("pageSize");
    const [payload, overviewPayload] = await Promise.all([
      fetchJSON(apiUrl(`articles?${query}`)),
      fetchJSON(apiUrl(`archive-overview?${overviewQuery}`))
    ]);
    return {
      items: extractArticles(payload),
      pagination: extractPagination(payload),
      overview: overviewPayload?.data || overviewPayload
    };
  }

  async function fetchArchiveOverview() {
    const payload = await fetchJSON(apiUrl("archive-overview?fromYear=1949"));
    return payload?.data || payload;
  }

  function overviewFromArticles(articles) {
    const years = articles
      .map((article) => Number(String(article.publishedAt || "").slice(0, 4)))
      .filter(Number.isInteger);
    const byStatus = Object.fromEntries(REVIEW_STATUS_KEYS.map((key) => [key, 0]));
    for (const article of articles) byStatus[statusKey(article.review.status)] += 1;
    return {
      total: articles.length,
      byStatus,
      earliestYear: years.length ? Math.min(...years) : null,
      latestYear: years.length ? Math.max(...years) : null,
      requestedStartYear: 1949,
      requestedEndYear: CURRENT_YEAR,
      byDecade: []
    };
  }

  function fallbackArchivePage(mode, page = 1) {
    const era = archiveEra();
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    const filtered = state.articles.filter((article) => {
      const year = Number(String(article.publishedAt || "").slice(0, 4));
      const haystack = [article.title, article.summary, article.source, article.category, ...article.tags].join(" ").toLocaleLowerCase("zh-CN");
      return (!query || haystack.includes(query))
        && (state.category === "all" || article.category === state.category)
        && (state.status === "all" || article.review.status === state.status)
        && year >= era.fromYear && year <= era.toYear
        && (mode !== "outlook" || article.predictions.length > 0);
    });
    const pageSize = 25;
    const totalPages = Math.ceil(filtered.length / pageSize);
    const safePage = totalPages ? Math.min(page, totalPages) : 1;
    return {
      items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
      pagination: { page: safePage, pageSize, total: filtered.length, totalPages },
      overview: overviewFromArticles(filtered)
    };
  }

  function extractCategories(payload, articles) {
    const source = Array.isArray(payload)
      ? payload
      : payload?.items || payload?.categories || payload?.data || [];
    const values = Array.isArray(source)
      ? source.map((item) => typeof item === "string" ? item : item.name || item.label || item.category).filter(Boolean)
      : [];
    const derived = articles.map((article) => article.category).filter(Boolean);
    return [...new Set([...values, ...derived])];
  }

  function formatDate(value, options = {}) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "日期待定");
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: options.short ? undefined : "numeric",
      month: options.numeric ? "2-digit" : "long",
      day: options.numeric ? "2-digit" : "numeric"
    }).format(date);
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "同步时间待定";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function statusBadge(value) {
    const key = statusKey(value);
    return `<span class="status-badge status-${key}">${escapeHTML(STATUS_META[key].label)}</span>`;
  }

  function articleHref(id) {
    return `#/articles/${encodeURIComponent(id)}`;
  }

  function listenHref(id) {
    return `#/listen/${encodeURIComponent(id)}`;
  }

  function sourceLink(article, label = "查看政策原文") {
    const url = safeExternalUrl(article.sourceUrl);
    if (!url) return `<span>${escapeHTML(article.source)}</span>`;
    return `<a class="source-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}<i data-lucide="external-link" aria-hidden="true"></i></a>`;
  }

  function renderIcons() {
    if (window.lucide?.createIcons) {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.9 } });
    }
  }

  function renderArticleViews(article) {
    const text = viewCountText(article?.views);
    return `<span class="article-view-count" data-article-view-id="${escapeHTML(article?.id || "")}" aria-label="浏览人数，${escapeHTML(text)}"><i data-lucide="eye" aria-hidden="true"></i><b data-article-view-text>${escapeHTML(text)}</b></span>`;
  }

  function updateViewDisplays() {
    document.querySelectorAll("[data-site-view]").forEach((element) => {
      const key = element.dataset.siteView;
      element.textContent = formatViewNumber(state.siteViews[key]);
    });

    document.querySelectorAll("[data-article-view-id]").forEach((element) => {
      const article = state.articles.find((item) => String(item.id) === String(element.dataset.articleViewId));
      if (!article) return;
      const text = viewCountText(article.views);
      const value = element.querySelector("[data-article-view-text]");
      if (value) value.textContent = text;
      element.setAttribute("aria-label", `浏览人数，${text}`);
    });
  }

  function applyViewResponse(payload) {
    const normalized = normalizeViewResponse(payload);
    if (normalized.site) state.siteViews = mergeViews(state.siteViews, normalized.site);
    if (normalized.article) {
      const article = state.articles.find((item) => String(item.id) === normalized.article.id);
      if (article) article.views = mergeViews(article.views, normalized.article);
    }
    updateViewDisplays();
    return normalized;
  }

  async function postView(articleId) {
    const body = createViewRequestBody(getVisitorId(), articleId);
    const response = await fetchJSON(apiUrl("views"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    applyViewResponse(response);
    return response;
  }

  function recordSiteView() {
    if (!siteViewRequest) {
      siteViewRequest = postView().catch((error) => {
        console.warn("Site view statistics unavailable", error);
        return null;
      });
    }
    return siteViewRequest;
  }

  function recordArticleView(articleId) {
    const id = normalizeArticleViewId(articleId);
    const key = id == null ? "" : String(id);
    if (!key || viewedArticleIds.has(key) || state.usingFallback) return Promise.resolve(null);
    viewedArticleIds.add(key);
    return postView(id).catch((error) => {
      viewedArticleIds.delete(key);
      console.warn("Article view statistics unavailable", error);
      return null;
    });
  }

  function demoNotice() {
    if (!state.usingFallback) return "";
    return `<div class="data-notice" role="status"><i data-lucide="info" aria-hidden="true"></i><span>当前 API 尚未返回内容，页面展示的是结构演示数据；正式上线后会自动替换为真实政策与核验记录。</span></div>`;
  }

  function renderStoryRow(article) {
    return `
      <article class="story-row">
        <div class="story-row-content">
          <div class="story-row-topline">
            <span class="category-label">${escapeHTML(article.category)}</span>
            <time class="story-date" datetime="${escapeHTML(article.publishedAt)}">${escapeHTML(formatDate(article.publishedAt, { numeric: true }))}</time>
          </div>
          <h3><a href="${articleHref(article.id)}">${escapeHTML(article.title)}</a></h3>
          <p>${escapeHTML(article.summary)}</p>
          <div class="story-meta">${statusBadge(article.review.status)}<span>${escapeHTML(article.source)}</span>${renderArticleViews(article)}</div>
        </div>
        <a href="${articleHref(article.id)}" tabindex="-1" aria-hidden="true">
          <img class="story-thumb" data-article-cover src="${escapeHTML(safeImageUrl(article.heroImage))}" alt="" loading="lazy">
        </a>
      </article>`;
  }

  function renderPolicyCard(article) {
    return `
      <article class="policy-card">
        <a href="${articleHref(article.id)}" tabindex="-1" aria-hidden="true"><img data-article-cover src="${escapeHTML(safeImageUrl(article.heroImage))}" alt="" loading="lazy"></a>
        <div class="policy-card-content">
          <span class="category-label">${escapeHTML(article.category)}</span>
          <h3><a href="${articleHref(article.id)}">${escapeHTML(article.title)}</a></h3>
          <p>${escapeHTML(article.summary)}</p>
          <div class="story-meta">${statusBadge(article.review.status)}<span>${escapeHTML(formatDate(article.publishedAt, { numeric: true }))}</span>${renderArticleViews(article)}</div>
        </div>
      </article>`;
  }

  function renderHome() {
    const featured = state.articles.find((article) => article.isFeatured || article.importance === "major") || state.articles[0];
    if (!featured) return renderEmpty("暂无政策内容", "数据同步完成后将在这里显示最新分析。");
    const remaining = state.articles.filter((article) => article.id !== featured.id);
    const counts = state.archiveOverview.byStatus;
    const coverage = state.archiveOverview.earliestYear
      ? `当前已核验覆盖 ${state.archiveOverview.earliestYear}—${state.archiveOverview.latestYear}`
      : "公开核验记录正在整理";
    const tracking = [...state.articles]
      .sort((a, b) => new Date(b.review.verifiedAt) - new Date(a.review.verifiedAt))
      .slice(0, 4);
    const categories = remaining.slice(2, 5).length ? remaining.slice(2, 5) : remaining.slice(0, 3);

    return `
      <div class="content-page">
        <div class="page-width">
          ${demoNotice()}
          <article class="lead-story">
            <img data-article-cover src="${escapeHTML(safeImageUrl(featured.heroImage))}" alt="" fetchpriority="high">
            <div class="lead-content">
              <p class="lead-kicker">重磅 · ${escapeHTML(featured.category)}</p>
              <h1>${escapeHTML(featured.title)}</h1>
              <p class="lead-summary">${escapeHTML(featured.summary)}</p>
              <div class="story-meta">
                <span><i data-lucide="calendar-days" aria-hidden="true"></i>${escapeHTML(formatDate(featured.publishedAt))}</span>
                <span><i data-lucide="landmark" aria-hidden="true"></i>${escapeHTML(featured.source)}</span>
                ${statusBadge(featured.review.status)}
                ${renderArticleViews(featured)}
              </div>
              <a class="lead-link" href="${articleHref(featured.id)}">阅读完整研判<i data-lucide="arrow-right" aria-hidden="true"></i></a>
            </div>
          </article>

          <section class="snapshot-strip" aria-label="政策复盘状态概览">
            <div class="snapshot-intro">
              <div class="snapshot-intro-copy"><strong>全范围研判</strong><span>目标 1949—${CURRENT_YEAR} · ${coverage} · ${state.archiveOverview.total} 篇公开分析</span></div>
              <div class="site-audience" aria-label="网站访客统计">
                <span>累计访客 <b data-site-view="total">${formatViewNumber(state.siteViews.total)}</b></span>
                <span>今日访客 <b data-site-view="today">${formatViewNumber(state.siteViews.today)}</b></span>
              </div>
            </div>
            <a class="snapshot-item status-verified" href="#/tracking?status=verified&era=all" aria-label="查看已验证文章，共 ${counts.verified} 篇"><strong>${counts.verified}</strong><small>已验证</small></a>
            <a class="snapshot-item status-partial" href="#/tracking?status=partial&era=all" aria-label="查看部分兑现文章，共 ${counts.partial} 篇"><strong>${counts.partial}</strong><small>部分兑现</small></a>
            <a class="snapshot-item status-ambiguous" href="#/tracking?status=ambiguous&era=all" aria-label="查看存在歧义文章，共 ${counts.ambiguous} 篇"><strong>${counts.ambiguous}</strong><small>存在歧义</small></a>
            <a class="snapshot-item status-watching" href="#/tracking?status=watching&era=all" aria-label="查看待观察文章，共 ${counts.watching} 篇"><strong>${counts.watching}</strong><small>待观察</small></a>
          </section>

          <div class="home-grid">
            <section aria-labelledby="latest-heading">
              <div class="section-heading"><h2 id="latest-heading">最新解读</h2><a href="#/archive">进入政策库<i data-lucide="arrow-right" aria-hidden="true"></i></a></div>
              <div class="story-list">${remaining.slice(0, 5).map(renderStoryRow).join("")}</div>
            </section>
            <aside class="insight-rail" aria-labelledby="tracking-heading">
              <div class="section-heading"><h2 id="tracking-heading">判断复盘</h2><a href="#/tracking">查看全部<i data-lucide="arrow-right" aria-hidden="true"></i></a></div>
              <div class="tracking-list">
                ${tracking.map((article) => `
                  <article class="tracking-card">
                    ${statusBadge(article.review.status)}
                    <h3><a href="${articleHref(article.id)}">${escapeHTML(article.title)}</a></h3>
                    <p>${escapeHTML(article.review.conclusion)}</p>
                    <div class="tracking-meta"><time datetime="${escapeHTML(article.review.verifiedAt)}">复核于 ${escapeHTML(formatDate(article.review.verifiedAt, { numeric: true }))}</time>${renderArticleViews(article)}</div>
                  </article>`).join("")}
              </div>
            </aside>
          </div>
        </div>

        ${categories.length ? `
          <section class="category-band" aria-labelledby="focus-heading">
            <div class="page-width">
              <div class="section-heading"><h2 id="focus-heading">重点栏目</h2><a href="#/archive">浏览全部<i data-lucide="arrow-right" aria-hidden="true"></i></a></div>
              <div class="category-grid">${categories.map(renderPolicyCard).join("")}</div>
            </div>
          </section>` : ""}
      </div>`;
  }

  function renderEmpty(title, copy) {
    return `<div class="empty-state"><div><i data-lucide="file-search" aria-hidden="true"></i><h2>${escapeHTML(title)}</h2><p>${escapeHTML(copy)}</p></div></div>`;
  }

  function archiveTitle(mode) {
    if (mode === "tracking") return { title: "落地追踪", copy: "把早期判断与后续公开证据放回同一条时间线，持续标注兑现程度与歧义。" };
    if (mode === "outlook") return { title: "前瞻研判", copy: "以可观察的政策信号和触发条件表达预判，并在新证据出现后回看判断。" };
    return { title: "政策库", copy: "按时间、领域和复盘状态检索政策原文、历史比较与持续分析。" };
  }

  function renderArchive(mode = "archive") {
    const results = state.archiveItems;
    const heading = archiveTitle(mode);
    const era = archiveEra();
    const overview = state.archiveFilteredOverview || state.archiveOverview;
    const actualCoverage = overview.earliestYear
      ? `已公开核验记录覆盖 ${overview.earliestYear}—${overview.latestYear}`
      : "该范围尚无通过核验的公开记录";
    const page = state.archivePagination.page;
    const totalPages = state.archivePagination.totalPages;
    const pageHref = (target) => {
      const params = new URLSearchParams();
      if (state.query) params.set("q", state.query);
      if (state.category !== "all") params.set("category", state.category);
      if (state.status !== "all") params.set("status", state.status);
      if (state.era !== "all") params.set("era", state.era);
      if (target > 1) params.set("page", String(target));
      return `#/${mode}${params.size ? `?${params}` : ""}`;
    };
    return `
      <div class="content-page">
        <div class="page-width">
          ${demoNotice()}
          <header class="page-heading">
            <div><p class="eyebrow">POLICY ARCHIVE</p><h1>${heading.title}</h1><p>${heading.copy}</p></div>
            <div class="page-heading-meta">目标范围 ${era.label}<br>${actualCoverage}<br>共 ${state.archivePagination.total} 条公开记录</div>
          </header>
          <section class="filter-panel" aria-label="政策筛选">
            <label class="filter-search">
              <span class="sr-only">搜索政策库</span>
              <i data-lucide="search" aria-hidden="true"></i>
              <input id="archive-search" type="search" value="${escapeHTML(state.query)}" placeholder="搜索标题、部门或关键词">
            </label>
            <div class="filter-selects">
              <label><span class="sr-only">历史阶段</span><select id="era-filter">${ARCHIVE_ERAS.map((item) => `<option value="${item.key}"${state.era === item.key ? " selected" : ""}>${item.label}</option>`).join("")}</select></label>
              <label><span class="sr-only">政策领域</span><select id="category-filter"><option value="all">全部领域</option>${state.categories.map((category) => `<option value="${escapeHTML(category)}"${state.category === category ? " selected" : ""}>${escapeHTML(category)}</option>`).join("")}</select></label>
              <label><span class="sr-only">复盘状态</span><select id="status-filter"><option value="all">全部状态</option>${REVIEW_STATUS_KEYS.map((key) => `<option value="${key}"${state.status === key ? " selected" : ""}>${STATUS_META[key].label}</option>`).join("")}</select></label>
            </div>
          </section>
          ${results.length ? `<section class="archive-list" aria-label="政策分析列表">${results.map((article) => `
            <article class="archive-row">
              <time class="archive-date" datetime="${escapeHTML(article.publishedAt)}">${escapeHTML(formatDate(article.publishedAt, { numeric: true }))}</time>
              <div>
                <span class="category-label">${escapeHTML(article.category)}</span>
                <h2><a href="${articleHref(article.id)}">${escapeHTML(article.title)}</a></h2>
                <p>${escapeHTML(article.summary)}</p>
              </div>
              <div class="archive-side">${statusBadge(article.review.status)}<span class="archive-source">${escapeHTML(article.source)}</span>${renderArticleViews(article)}</div>
            </article>`).join("")}</section>` : renderEmpty("没有匹配的政策", "该范围可能仍在核验中，或可尝试清除关键词和调整筛选条件。")}
          ${totalPages > 1 ? `<nav class="archive-pagination" aria-label="政策库分页">
            <a class="pagination-button${page <= 1 ? " is-disabled" : ""}" href="${pageHref(Math.max(1, page - 1))}"${page <= 1 ? ' aria-disabled="true" tabindex="-1"' : ""}><i data-lucide="chevron-left" aria-hidden="true"></i><span>上一页</span></a>
            <span>第 ${page} / ${totalPages} 页</span>
            <a class="pagination-button${page >= totalPages ? " is-disabled" : ""}" href="${pageHref(Math.min(totalPages, page + 1))}"${page >= totalPages ? ' aria-disabled="true" tabindex="-1"' : ""}><span>下一页</span><i data-lucide="chevron-right" aria-hidden="true"></i></a>
          </nav>` : ""}
        </div>
      </div>`;
  }

  function renderContent(content) {
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") return `<p>${escapeHTML(part)}</p>`;
        if (!part || typeof part !== "object") return "";
        const heading = part.heading || part.title;
        const paragraphs = normalizeList(part.paragraphs || part.content || part.body);
        return `${heading ? `<h3>${escapeHTML(heading)}</h3>` : ""}${paragraphs.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}`;
      }).join("");
    }

    return String(content || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHTML(paragraph.replace(/^#{1,3}\s+/, ""))}</p>`)
      .join("");
  }

  function comparisonRows(article) {
    return article.comparisons.map((item) => `
      <tr>
        <td>${escapeHTML(item.dimension || item.aspect || item.name || "比较项")}</td>
        <td>${escapeHTML(item.previous || item.before || item.historical || "待补充")}</td>
        <td>${escapeHTML(item.current || item.now || item.latest || "待补充")}</td>
        <td>${escapeHTML(item.implication || item.impact || item.analysis || "待观察")}</td>
      </tr>`).join("");
  }

  function evidenceTimeline(article) {
    const list = article.evidence.length ? article.evidence : [
      { date: article.publishedAt, title: "政策原文收录", description: "已建立原文快照，后续执行证据出现后继续补充。", status: "watching", source: article.source, sourceUrl: article.sourceUrl }
    ];
    return list.map((item) => {
      const url = safeExternalUrl(item.sourceUrl || item.source_url);
      return `
        <article class="evidence-item">
          <time class="evidence-date" datetime="${escapeHTML(item.date || "")}">${escapeHTML(formatDate(item.date, { numeric: true }))}</time>
          <div class="evidence-content">
            <h3>${escapeHTML(item.title || item.event || "跟踪节点")}${item.eventTypeLabel || item.event_type_label ? `<span class="event-type-label">${escapeHTML(item.eventTypeLabel || item.event_type_label)}</span>` : ""}${statusBadge(item.status)}</h3>
            <p>${escapeHTML(item.description || item.detail || item.content || "")}</p>
            ${item.source ? (url ? `<a class="evidence-source" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.source)}<i data-lucide="external-link" aria-hidden="true"></i></a>` : `<span class="evidence-source">${escapeHTML(item.source)}</span>`) : ""}
          </div>
        </article>`;
    }).join("");
  }

  function ambiguityList(article) {
    if (!article.ambiguities.length) return "";
    return `
      <section class="article-section" aria-labelledby="ambiguity-title">
        <h2 id="ambiguity-title">哪些问题还不能下结论</h2>
        <p class="article-section-intro">这里记录的是证据冲突和信息缺口，不是含糊其辞的“有待观察”。</p>
        <div class="ambiguity-list">
          ${article.ambiguities.map((item) => `
            <article class="ambiguity-item">
              <div>${statusBadge("ambiguous")}</div>
              <div><h3>${escapeHTML(item.issue || item.title || "待澄清问题")}</h3><p>${escapeHTML(item.why || item.reason || item.description || "")}</p>${item.nextEvidence || item.next_evidence ? `<p class="verification-target"><strong>怎样才能确认：</strong>${escapeHTML(item.nextEvidence || item.next_evidence)}</p>` : ""}</div>
            </article>`).join("")}
        </div>
      </section>`;
  }

  function predictionList(article) {
    if (!article.predictions.length) return "";
    return `
      <section class="article-section" aria-labelledby="prediction-title">
        <h2 id="prediction-title">接下来最值得观察什么</h2>
        <p class="article-section-intro">每条预判都给出成立理由、验证时间和当前置信度；未到验证节点前不是事实。</p>
        <div class="signal-list">
          ${article.predictions.map((item) => `
            <article class="signal-item">
              <div class="signal-meta"><span class="outlook-label">${escapeHTML(item.timeframe || item.window || "后续观察")}</span><span class="confidence">置信度 ${escapeHTML(item.confidence || "待评估")}</span></div>
              <div><h3>${escapeHTML(item.signal || item.title || "政策信号")}</h3><p><strong>为什么这样判断：</strong>${escapeHTML(item.trigger || item.condition || item.description || "")}</p></div>
            </article>`).join("")}
        </div>
      </section>`;
  }

  function analysisVersionHistory(article) {
    if (!article.analysisHistory.length) return "";
    return `
      <section class="article-section" aria-labelledby="version-history-title">
        <h2 id="version-history-title">这个结论是怎么变化的</h2>
        <p class="article-section-intro">旧结论不会被覆盖。这里说明当时怎么判断，以及后来增加了什么证据或边界。</p>
        <div class="version-history">
          ${article.analysisHistory.map((version, index) => {
            const isCurrent = article.analysisVersion
              ? Number(version.version) === Number(article.analysisVersion)
              : index === 0;
            const createdAt = version.createdAt || version.created_at;
            const summary = version.evidenceSummary || version.evidence_summary || version.interpretation || "该版本暂无证据摘要。";
            return `
              <article class="version-item${isCurrent ? " is-current" : ""}">
                <div class="version-meta">
                  <span class="version-number">V${escapeHTML(version.version || article.analysisHistory.length - index)}</span>
                  <span>${isCurrent ? "当前版本" : "历史版本"}</span>
                  ${createdAt ? `<time datetime="${escapeHTML(createdAt)}">${escapeHTML(formatDate(createdAt, { numeric: true }))}</time>` : ""}
                </div>
                <div><h3>${escapeHTML(version.headline || `第 ${version.version || article.analysisHistory.length - index} 版研判`)}</h3><p>${escapeHTML(summary)}</p></div>
              </article>`;
          }).join("")}
        </div>
      </section>`;
  }

  function frameworkEntry(item, fallbackLabel) {
    if (typeof item === "string") return { label: fallbackLabel, detail: item };
    if (!item || typeof item !== "object") return { label: fallbackLabel, detail: "" };
    return {
      label: item.label || item.name || item.group || item.step || item.tool || item.title || fallbackLabel,
      detail: item.detail || item.effect || item.mechanism || item.action || item.condition || item.description || ""
    };
  }

  function frameworkList(items, fallbackLabel) {
    return items.map((item) => {
      const entry = frameworkEntry(item, fallbackLabel);
      return `<li><strong>${escapeHTML(entry.label)}</strong><span>${escapeHTML(entry.detail)}</span></li>`;
    }).join("");
  }

  function policyVerdict(article) {
    const framework = article.analysisFramework;
    const conclusion = framework?.bottomLine || article.review.conclusion || article.analysisLead;
    const perspective = framework?.perspective || "公共政策执行与实际影响";
    const note = framework?.perspectiveNote
      || "从政策公开目标出发，依次看政策工具、执行责任、受影响对象和实际结果。";
    return `
      <section class="policy-verdict" aria-labelledby="verdict-title">
        <div class="verdict-heading"><p class="eyebrow">结论先行</p>${statusBadge(article.review.status)}</div>
        <h2 id="verdict-title">${escapeHTML(conclusion)}</h2>
        <div class="analysis-perspective">
          <span><i data-lucide="scan-search" aria-hidden="true"></i>分析视角</span>
          <p><strong>${escapeHTML(perspective)}</strong>：${escapeHTML(note)}</p>
        </div>
      </section>`;
  }

  function policyFramework(article) {
    const framework = article.analysisFramework;
    if (!framework?.ready) {
      return `
        <section class="article-section" aria-labelledby="framework-title">
          <h2 id="framework-title">政策怎么理解</h2>
          <div class="analysis-unavailable"><i data-lucide="file-search" aria-hidden="true"></i><div><strong>结构化解读尚未完成</strong><p>当前记录还没有同时通过政策问题、工具、影响对象和执行路径四项复核，因此暂不展示推断式拆解。</p></div></div>
        </section>`;
    }
    return `
      <section class="article-section" aria-labelledby="framework-title">
        <h2 id="framework-title">政策怎么理解</h2>
        <p class="article-section-intro">把政策语言还原成“为什么做、用什么办法、影响谁、怎样落地”。</p>
        <div class="policy-logic">
          <div class="logic-row logic-problem"><div class="logic-label"><span>01</span><strong>要解决的问题</strong></div><p>${escapeHTML(framework.problem)}</p></div>
          <div class="logic-row"><div class="logic-label"><span>02</span><strong>使用什么工具</strong></div><ul>${frameworkList(framework.tools, "政策工具")}</ul></div>
          <div class="logic-row"><div class="logic-label"><span>03</span><strong>具体影响谁</strong></div><ul>${frameworkList(framework.affectedGroups, "影响对象")}</ul></div>
          <div class="logic-row"><div class="logic-label"><span>04</span><strong>怎样真正落地</strong></div><ol>${frameworkList(framework.executionPath, "执行环节")}</ol></div>
        </div>
      </section>`;
  }

  function historicalChangeSection(article) {
    if (!article.comparisons.length) {
      return `
        <section class="article-section" aria-labelledby="comparison-title">
          <h2 id="comparison-title">跟过去相比，变了什么</h2>
          <div class="analysis-unavailable compact"><i data-lucide="git-compare-arrows" aria-hidden="true"></i><div><strong>暂无可核验的往期差异</strong><p>当前没有更早的同政策脉络原文，或实质差异尚未完成逐条核对。</p></div></div>
        </section>`;
    }
    return `
      <section class="article-section" aria-labelledby="comparison-title">
        <h2 id="comparison-title">跟过去相比，变了什么</h2>
        <p class="article-section-intro">只比较同一政策脉络中的目标、工具和执行逻辑，不用标题变化代替实质变化。</p>
        <div class="comparison-wrap">
          <table class="comparison-table">
            <thead><tr><th>比较维度</th><th>过去怎么做</th><th>现在怎么做</th><th>意味着什么</th></tr></thead>
            <tbody>${comparisonRows(article)}</tbody>
          </table>
        </div>
      </section>`;
  }

  function evidenceBoundary(article) {
    const framework = article.analysisFramework;
    if (!framework?.confirmed.length && !framework?.unconfirmed.length) return "";
    const renderItems = (items) => items.map((item) => {
      const text = typeof item === "string" ? item : item.statement || item.detail || item.description || "";
      return `<li>${escapeHTML(text)}</li>`;
    }).join("");
    return `
      <section class="article-section" aria-labelledby="boundary-title">
        <h2 id="boundary-title">目前能确认到哪一步</h2>
        <div class="evidence-boundary">
          <div class="boundary-confirmed"><h3><i data-lucide="badge-check" aria-hidden="true"></i>已有依据</h3><ul>${renderItems(framework.confirmed)}</ul></div>
          <div class="boundary-unconfirmed"><h3><i data-lucide="circle-help" aria-hidden="true"></i>不能外推</h3><ul>${renderItems(framework.unconfirmed)}</ul></div>
        </div>
      </section>`;
  }

  function originalTextSection(article) {
    return `
      <details class="source-text">
        <summary><span><i data-lucide="file-text" aria-hidden="true"></i>查看收录的政策原文</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
        <div class="article-prose">${renderContent(article.content)}</div>
      </details>`;
  }

  function renderArticle(article) {
    const tags = article.tags.length ? article.tags : [article.category];
    const sourceUrl = safeExternalUrl(article.sourceUrl);
    const narrationMinutes = article.contentText ? Math.max(1, Math.ceil(article.contentText.length / 250)) : null;
    return `
      <article class="content-page">
        <div class="page-width">
          ${demoNotice()}
          <nav class="breadcrumb" aria-label="面包屑"><a href="#/">首页</a><i data-lucide="chevron-right" aria-hidden="true"></i><a href="#/archive">政策库</a><i data-lucide="chevron-right" aria-hidden="true"></i><span>${escapeHTML(article.category)}</span></nav>
          <header class="article-header">
            <p class="article-kicker">${escapeHTML(article.category)} · 持续复盘</p>
            <h1>${escapeHTML(article.title)}</h1>
            <p class="article-deck">${escapeHTML(article.summary)}</p>
            <div class="article-meta">
              <span><i data-lucide="calendar-days" aria-hidden="true"></i>${escapeHTML(formatDate(article.publishedAt))}</span>
              <span><i data-lucide="landmark" aria-hidden="true"></i>${escapeHTML(article.source)}</span>
              <span><i data-lucide="clock-3" aria-hidden="true"></i>${escapeHTML(article.readTime)} 分钟阅读</span>
              ${renderArticleViews(article)}
              ${statusBadge(article.review.status)}
            </div>
            <a class="listen-entry" href="${listenHref(article.id)}" aria-label="听正文：${escapeHTML(article.title)}">
              <span class="listen-entry-icon" aria-hidden="true"><i data-lucide="headphones"></i></span>
              <span><strong>听正文</strong><small>${narrationMinutes ? `约 ${narrationMinutes} 分钟` : "正文待同步"}</small></span>
              <i data-lucide="chevron-right" aria-hidden="true"></i>
            </a>
          </header>
          ${policyVerdict(article)}
          <figure>
            <img class="article-hero" data-article-cover src="${escapeHTML(safeImageUrl(article.heroImage))}" alt="${escapeHTML(article.imageCaption || article.title)}">
            ${article.imageCaption ? `<figcaption class="image-caption">${escapeHTML(article.imageCaption)}</figcaption>` : ""}
          </figure>

          <div class="article-layout">
            <div class="article-body">
              ${policyFramework(article)}
              ${historicalChangeSection(article)}
              ${evidenceBoundary(article)}

              <section class="article-section" aria-labelledby="evidence-title">
                <h2 id="evidence-title">结论依据</h2>
                <p class="article-section-intro">正式发文只证明政策已经发布；实施、资金和结果必须由后续公开证据分别确认。</p>
                <div class="evidence-timeline">${evidenceTimeline(article)}</div>
              </section>

              ${ambiguityList(article)}
              ${predictionList(article)}
              ${analysisVersionHistory(article)}
              ${originalTextSection(article)}
              <p class="method-note"><strong>复核口径：</strong>最后复核回答的是“政策目标是否已经进入执行、资金或项目是否发生、结果是否出现”，不评价政策立场，也不构成投资建议。最后复核于 ${escapeHTML(formatDate(article.review.verifiedAt))}；新证据出现后会新增版本，不覆盖旧判断。</p>
            </div>

            <aside class="article-aside" aria-label="文章信息">
              <section class="aside-block">
                <h2>当前证据状态</h2>
                <div class="review-stamp status-${escapeHTML(article.review.status)}">
                  ${statusBadge(article.review.status)}
                  <strong>${escapeHTML(article.review.conclusion)}</strong>
                  <p>综合置信度：${escapeHTML(article.review.confidence)}</p>
                </div>
              </section>
              <section class="aside-block">
                <h2>原始信源</h2>
                <dl><dt>发布来源</dt><dd>${escapeHTML(article.source)}</dd><dt>发布日期</dt><dd>${escapeHTML(formatDate(article.publishedAt))}</dd><dt>原文</dt><dd>${sourceUrl ? sourceLink(article) : "演示数据暂无外链"}</dd></dl>
              </section>
              <section class="aside-block">
                <h2>相关主题</h2>
                <div class="tag-list">${tags.map((tag) => `<a class="tag" href="#/archive?tag=${encodeURIComponent(tag)}">${escapeHTML(tag)}</a>`).join("")}</div>
              </section>
            </aside>
          </div>
        </div>
      </article>`;
  }

  function estimateSpeechSeconds(characterCount, rate = 1) {
    const safeRate = Math.max(0.5, Number(rate) || 1);
    return Math.max(0, Number(characterCount) || 0) / (4.2 * safeRate);
  }

  function formatSpeechTime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function speechTotalCharacters() {
    return audioState.segments.length ? audioState.segments[audioState.segments.length - 1].end : 0;
  }

  function renderAudioTranscript(segments) {
    if (!segments.length) {
      return `<div class="audio-transcript-empty"><i data-lucide="volume-x" aria-hidden="true"></i><p>这篇文章的正文尚未同步。</p></div>`;
    }

    const paragraphs = [];
    segments.forEach((segment, index) => {
      if (!paragraphs[segment.paragraphIndex]) paragraphs[segment.paragraphIndex] = [];
      paragraphs[segment.paragraphIndex].push(
        `<span class="audio-transcript-segment" data-segment-index="${index}">${escapeHTML(segment.text)}</span>`
      );
    });
    return paragraphs.filter(Boolean).map((parts) => `<p>${parts.join("")}</p>`).join("");
  }

  function prepareAudioArticle(article) {
    stopAudioPlayback({ resetPosition: true, clearArticle: true, silent: true });
    audioState.articleId = String(article.id);
    audioState.segments = segmentSpeechText(article.contentText);
    audioState.lastHighlightedIndex = -1;
  }

  function renderAudioPlayer(article) {
    prepareAudioArticle(article);
    const adjacent = article.neighbors
      ? {
          previous: neighborArticleId(article.neighbors.previous),
          next: neighborArticleId(article.neighbors.next)
        }
      : getAdjacentArticleIds(state.articles, article.id);
    const totalCharacters = speechTotalCharacters();
    const supported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    const disabled = !supported || !totalCharacters;
    const totalTime = formatSpeechTime(estimateSpeechSeconds(totalCharacters, audioState.rate));

    return `
      <section class="audio-player-page" aria-label="正文播放器">
        <img class="audio-player-backdrop" data-article-cover src="${escapeHTML(safeImageUrl(article.heroImage))}" alt="" aria-hidden="true">
        <div class="audio-player-shade" aria-hidden="true"></div>
        <div class="audio-player-shell">
          <header class="audio-player-header">
            <a class="audio-icon-button" href="${articleHref(article.id)}" aria-label="返回文章" title="返回文章">
              <i data-lucide="arrow-left" aria-hidden="true"></i>
            </a>
            <span>正文播放</span>
            <span class="audio-header-spacer" aria-hidden="true"></span>
          </header>

          <div class="audio-player-main">
            <div class="audio-title-block">
              <p>${escapeHTML(article.category)} · ${escapeHTML(formatDate(article.publishedAt, { numeric: true }))}</p>
              <h1>${escapeHTML(article.title)}</h1>
              <span>${escapeHTML(article.source)}</span>
              <div class="audio-view-meta">${renderArticleViews(article)}</div>
            </div>
            <div class="audio-transcript" id="audio-transcript" tabindex="0" aria-label="文章正文">
              ${renderAudioTranscript(audioState.segments)}
            </div>
          </div>

          <footer class="audio-player-controls">
            <div class="audio-progress-row">
              <input id="audio-progress" type="range" min="0" max="${Math.max(1, totalCharacters)}" value="0" step="1" aria-label="播放进度" ${disabled ? "disabled" : ""}>
              <div class="audio-time-row"><time id="audio-current-time">0:00</time><time id="audio-total-time">${totalTime}</time></div>
            </div>
            <div class="audio-control-row">
              <button class="audio-icon-button audio-skip-button" id="audio-previous" type="button" data-article-id="${escapeHTML(adjacent.previous || "")}" aria-label="上一篇" title="上一篇" ${adjacent.previous ? "" : "disabled"}>
                <i data-lucide="skip-back" aria-hidden="true"></i>
              </button>
              <button class="audio-play-button" id="audio-play-toggle" type="button" aria-label="播放" title="播放" ${disabled ? "disabled" : ""}>
                <span class="audio-play-icon"><i data-lucide="play" aria-hidden="true"></i></span>
                <span class="audio-pause-icon"><i data-lucide="pause" aria-hidden="true"></i></span>
              </button>
              <button class="audio-icon-button audio-skip-button" id="audio-next" type="button" data-article-id="${escapeHTML(adjacent.next || "")}" aria-label="下一篇" title="下一篇" ${adjacent.next ? "" : "disabled"}>
                <i data-lucide="skip-forward" aria-hidden="true"></i>
              </button>
            </div>
            <div class="audio-control-meta">
              <span id="audio-status" role="status" aria-live="polite">${!supported ? "当前浏览器不支持系统朗读" : (totalCharacters ? "准备播放" : "正文暂不可播放")}</span>
              <label class="audio-rate-control">
                <i data-lucide="gauge" aria-hidden="true"></i>
                <span class="sr-only">播放速度</span>
                <select id="audio-rate" aria-label="播放速度" ${disabled ? "disabled" : ""}>
                  ${[0.8, 1, 1.25, 1.5, 2].map((rate) => `<option value="${rate}"${rate === audioState.rate ? " selected" : ""}>${rate}x</option>`).join("")}
                </select>
              </label>
            </div>
          </footer>
        </div>
      </section>`;
  }

  function clearAudioProgressTimer() {
    window.clearTimeout(audioState.progressTimer);
    audioState.progressTimer = 0;
  }

  function updateAudioPlayerUI({ scrollTranscript = false } = {}) {
    const totalCharacters = speechTotalCharacters();
    const progress = document.querySelector("#audio-progress");
    const currentTime = document.querySelector("#audio-current-time");
    const totalTime = document.querySelector("#audio-total-time");
    const playToggle = document.querySelector("#audio-play-toggle");
    const status = document.querySelector("#audio-status");

    if (progress) progress.value = String(Math.min(audioState.absolutePosition, totalCharacters));
    if (currentTime) currentTime.textContent = formatSpeechTime(estimateSpeechSeconds(audioState.absolutePosition, audioState.rate));
    if (totalTime) totalTime.textContent = formatSpeechTime(estimateSpeechSeconds(totalCharacters, audioState.rate));
    if (playToggle) {
      playToggle.dataset.playing = String(audioState.isPlaying);
      playToggle.setAttribute("aria-label", audioState.isPlaying ? "暂停" : "播放");
      playToggle.title = audioState.isPlaying ? "暂停" : "播放";
    }
    if (status) {
      if (!totalCharacters) status.textContent = "正文暂不可播放";
      else if (audioState.absolutePosition >= totalCharacters) status.textContent = "播放完毕";
      else if (audioState.isPlaying) status.textContent = "播放中";
      else status.textContent = audioState.absolutePosition > 0 ? "已暂停" : "准备播放";
    }

    if (audioState.lastHighlightedIndex !== audioState.segmentIndex) {
      document.querySelectorAll(".audio-transcript-segment.is-active").forEach((element) => {
        element.classList.remove("is-active");
        element.removeAttribute("aria-current");
      });
      const active = document.querySelector(`[data-segment-index="${audioState.segmentIndex}"]`);
      if (active) {
        active.classList.add("is-active");
        active.setAttribute("aria-current", "true");
        if (scrollTranscript) {
          const transcript = document.querySelector("#audio-transcript");
          const top = active.offsetTop - (transcript?.clientHeight || 0) * 0.35;
          transcript?.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      }
      audioState.lastHighlightedIndex = audioState.segmentIndex;
    }
  }

  function startAudioProgressTimer() {
    clearAudioProgressTimer();
    const tick = () => {
      if (!audioState.isPlaying || !audioState.segments.length) return;
      const segment = audioState.segments[audioState.segmentIndex];
      if (!segment) return;
      const now = performance.now();
      if (!audioState.lastBoundaryAt || now - audioState.lastBoundaryAt > 900) {
        const elapsed = (now - audioState.segmentStartedAt) / 1000;
        const estimatedOffset = audioState.segmentStartOffset + elapsed * 4.2 * audioState.rate;
        audioState.segmentOffset = Math.min(segment.text.length - 1, Math.max(audioState.segmentOffset, estimatedOffset));
        audioState.absolutePosition = segment.start + audioState.segmentOffset;
      }
      updateAudioPlayerUI();
      audioState.progressTimer = window.setTimeout(tick, 250);
    };
    audioState.progressTimer = window.setTimeout(tick, 250);
  }

  function selectChineseVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return voices.find((voice) => /^zh[-_]CN$/i.test(voice.lang))
      || voices.find((voice) => /^zh/i.test(voice.lang))
      || null;
  }

  function stopAudioPlayback({ resetPosition = false, clearArticle = false, silent = false } = {}) {
    audioState.token += 1;
    audioState.isPlaying = false;
    audioState.utterance = null;
    clearAudioProgressTimer();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (resetPosition) {
      audioState.segmentIndex = 0;
      audioState.segmentOffset = 0;
      audioState.absolutePosition = 0;
    }
    if (clearArticle) {
      audioState.articleId = null;
      audioState.segments = [];
    }
    if (!silent) updateAudioPlayerUI();
  }

  function finishAudioPlayback() {
    clearAudioProgressTimer();
    audioState.isPlaying = false;
    audioState.utterance = null;
    audioState.absolutePosition = speechTotalCharacters();
    if (audioState.segments.length) {
      audioState.segmentIndex = audioState.segments.length - 1;
      audioState.segmentOffset = audioState.segments[audioState.segmentIndex].text.length;
    }
    updateAudioPlayerUI({ scrollTranscript: true });
  }

  function speakCurrentAudioSegment() {
    if (!audioState.isPlaying || !audioState.segments.length) return;
    const segment = audioState.segments[audioState.segmentIndex];
    if (!segment) {
      finishAudioPlayback();
      return;
    }
    const remainingText = segment.text.slice(Math.floor(audioState.segmentOffset));
    if (!remainingText) {
      if (audioState.segmentIndex >= audioState.segments.length - 1) {
        finishAudioPlayback();
        return;
      }
      audioState.segmentIndex += 1;
      audioState.segmentOffset = 0;
      audioState.absolutePosition = audioState.segments[audioState.segmentIndex].start;
      speakCurrentAudioSegment();
      return;
    }

    const utterance = new window.SpeechSynthesisUtterance(remainingText);
    const voice = selectChineseVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "zh-CN";
    utterance.rate = audioState.rate;
    const token = ++audioState.token;
    const startOffset = Math.floor(audioState.segmentOffset);
    audioState.utterance = utterance;
    audioState.segmentStartOffset = startOffset;
    audioState.segmentStartedAt = performance.now();
    audioState.lastBoundaryAt = 0;

    utterance.onboundary = (event) => {
      if (token !== audioState.token || !audioState.isPlaying) return;
      audioState.lastBoundaryAt = performance.now();
      audioState.segmentOffset = Math.min(segment.text.length, startOffset + Math.max(0, event.charIndex || 0));
      audioState.absolutePosition = segment.start + audioState.segmentOffset;
      updateAudioPlayerUI();
    };
    utterance.onend = () => {
      if (token !== audioState.token || !audioState.isPlaying) return;
      clearAudioProgressTimer();
      if (audioState.segmentIndex >= audioState.segments.length - 1) {
        finishAudioPlayback();
        return;
      }
      audioState.segmentIndex += 1;
      audioState.segmentOffset = 0;
      audioState.absolutePosition = audioState.segments[audioState.segmentIndex].start;
      updateAudioPlayerUI({ scrollTranscript: true });
      speakCurrentAudioSegment();
    };
    utterance.onerror = (event) => {
      if (token !== audioState.token || ["canceled", "interrupted"].includes(event.error)) return;
      clearAudioProgressTimer();
      audioState.isPlaying = false;
      audioState.utterance = null;
      updateAudioPlayerUI();
      const status = document.querySelector("#audio-status");
      if (status) status.textContent = "播放中断，请重试";
    };

    updateAudioPlayerUI({ scrollTranscript: true });
    startAudioProgressTimer();
    window.speechSynthesis.speak(utterance);
  }

  function toggleAudioPlayback() {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      showToast("当前浏览器不支持系统朗读。", true);
      return;
    }
    if (!audioState.segments.length) {
      showToast("这篇文章的正文尚未同步。", true);
      return;
    }
    if (audioState.isPlaying) {
      stopAudioPlayback();
      return;
    }
    if (audioState.absolutePosition >= speechTotalCharacters()) {
      audioState.segmentIndex = 0;
      audioState.segmentOffset = 0;
      audioState.absolutePosition = 0;
      audioState.lastHighlightedIndex = -1;
    }
    audioState.isPlaying = true;
    speakCurrentAudioSegment();
  }

  function seekAudioPlayback(position) {
    const wasPlaying = audioState.isPlaying;
    audioState.token += 1;
    clearAudioProgressTimer();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    const nextPosition = findSpeechPosition(audioState.segments, position);
    audioState.segmentIndex = nextPosition.index;
    audioState.segmentOffset = nextPosition.offset;
    audioState.absolutePosition = audioState.segments.length
      ? audioState.segments[nextPosition.index].start + nextPosition.offset
      : 0;
    audioState.lastHighlightedIndex = -1;
    audioState.isPlaying = wasPlaying && audioState.absolutePosition < speechTotalCharacters();
    updateAudioPlayerUI({ scrollTranscript: true });
    if (audioState.isPlaying) speakCurrentAudioSegment();
  }

  function bindAudioControls() {
    const playToggle = document.querySelector("#audio-play-toggle");
    if (!playToggle) return;
    const progress = document.querySelector("#audio-progress");
    const rate = document.querySelector("#audio-rate");
    playToggle.addEventListener("click", toggleAudioPlayback);
    progress?.addEventListener("input", (event) => {
      const currentTime = document.querySelector("#audio-current-time");
      if (currentTime) currentTime.textContent = formatSpeechTime(estimateSpeechSeconds(Number(event.target.value), audioState.rate));
    });
    progress?.addEventListener("change", (event) => seekAudioPlayback(Number(event.target.value)));
    rate?.addEventListener("change", (event) => {
      const nextRate = Number(event.target.value);
      if (![0.8, 1, 1.25, 1.5, 2].includes(nextRate)) return;
      const wasPlaying = audioState.isPlaying;
      audioState.token += 1;
      clearAudioProgressTimer();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      audioState.rate = nextRate;
      audioState.isPlaying = wasPlaying;
      updateAudioPlayerUI();
      if (wasPlaying) speakCurrentAudioSegment();
    });
    document.querySelectorAll("#audio-previous, #audio-next").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.articleId) location.hash = listenHref(button.dataset.articleId);
      });
    });
    updateAudioPlayerUI();
  }

  function renderAbout() {
    return `
      <div class="content-page">
        <div class="page-width">
          <header class="page-heading"><div><p class="eyebrow">METHODOLOGY</p><h1>方法说明</h1><p>把“当时怎么判断”与“后来发生了什么”分开记录，让政策分析可以被回看和修正。</p></div></header>
          <div class="about-layout">
            <div class="about-prose">
              <h2>先固定原文，再表达判断</h2><p>每篇分析保存政策来源、发布时间与抓取快照。事实、解释和前瞻信号分层呈现，避免把尚未发生的推断写成既成事实。</p>
              <h2>用落地证据持续复盘</h2><p>后续公开细则、执行数据和权威答复会进入证据时间线。新证据与原判断冲突时，更新当前状态，但保留此前结论与复核时间。</p>
              <h2>明确不确定性</h2><p>“存在歧义”并不等于政策无效，而是现有信源不足以支持唯一结论。前瞻研判必须给出触发条件和置信度，并在观察窗口结束后复盘。</p>
            </div>
            <aside class="aside-block">
              <h2>状态口径</h2>
              <div class="status-legend">
                <div class="legend-row">${statusBadge("verified")}<p>关键判断已获得多项独立或连续证据支持。</p></div>
                <div class="legend-row">${statusBadge("partial")}<p>部分措施或效果已经发生，仍有重要环节尚未兑现。</p></div>
                <div class="legend-row">${statusBadge("ambiguous")}<p>公开口径、执行结果或因果解释之间仍有冲突。</p></div>
                <div class="legend-row">${statusBadge("watching")}<p>政策刚发布或证据尚少，暂不下确定结论。</p></div>
              </div>
            </aside>
          </div>
        </div>
      </div>`;
  }

  function routeInfo() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, queryString = ""] = raw.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    return { parts, params: new URLSearchParams(queryString) };
  }

  async function getArticle(id) {
    const existing = state.articles.find((article) => String(article.id) === String(id));
    if (state.usingFallback) return existing;
    try {
      const payload = await fetchJSON(apiUrl(`articles/${encodeURIComponent(id)}`));
      const detail = payload?.data || payload;
      const rawArticle = detail?.article || payload?.article || detail;
      const raw = {
        ...rawArticle,
        neighbors: detail?.neighbors || rawArticle?.neighbors,
        analysisHistory: detail?.analysisHistory || rawArticle?.analysisHistory,
        analysisFramework: detail?.currentAnalysis?.framework || rawArticle?.analysisFramework,
        assessmentSnapshots: detail?.assessmentSnapshots || rawArticle?.assessmentSnapshots
      };
      const normalized = normalizeArticle(raw, 0, { includeNarration: true });
      if (normalized.views.total == null && normalized.views.today == null && existing?.views) {
        normalized.views = mergeViews(normalized.views, existing.views);
      }
      const index = state.articles.findIndex((article) => String(article.id) === String(id));
      if (index >= 0) state.articles[index] = normalized;
      else state.articles.push(normalized);
      return normalized;
    } catch (error) {
      console.warn("Article detail API unavailable", error);
      return existing;
    }
  }

  function updateActiveNav(route) {
    const active = ["archive", "tracking", "outlook"].includes(route) ? route : "home";
    document.querySelectorAll("[data-nav]").forEach((link) => {
      link.classList.toggle("is-active", link.dataset.nav === active);
      if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  async function renderRoute({ preserveScroll = false } = {}) {
    const version = ++state.routeVersion;
    const { parts, params } = routeInfo();
    const route = parts[0] || "home";
    const audioRoute = route === "listen" && Boolean(parts[1]) && window.matchMedia("(max-width: 820px)").matches;

    stopAudioPlayback({ resetPosition: true, clearArticle: true, silent: true });
    document.body.classList.toggle("is-listening", audioRoute);

    let html;
    let articleForView = null;
    if ((route === "articles" || route === "listen") && parts[1]) {
      elements.app.innerHTML = `<div class="loading-screen"><span class="loading-mark">政</span><p>正在读取分析记录…</p></div>`;
      renderIcons();
      const article = await getArticle(parts[1]);
      if (version !== state.routeVersion) return;
      articleForView = article;
      html = article
        ? (audioRoute ? renderAudioPlayer(article) : renderArticle(article))
        : `<div class="content-page"><div class="page-width">${renderEmpty("未找到这篇分析", "它可能已归档，或链接地址不完整。")}</div></div>`;
    } else if (["archive", "tracking", "outlook"].includes(route)) {
      state.query = (params.get("q") || params.get("tag") || "").trim();
      state.category = params.get("category") || "all";
      state.status = REVIEW_STATUS_KEYS.includes(params.get("status")) ? params.get("status") : "all";
      state.era = ARCHIVE_ERAS.some((item) => item.key === params.get("era")) ? params.get("era") : "all";
      const requestedPage = Number(params.get("page") || 1);
      const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      elements.app.innerHTML = `<div class="loading-screen"><span class="loading-mark">政</span><p>正在读取已核验记录…</p></div>`;
      renderIcons();
      try {
        const result = state.usingFallback
          ? fallbackArchivePage(route, page)
          : await fetchArchivePage(route, page);
        if (version !== state.routeVersion) return;
        state.archiveItems = result.items;
        state.archivePagination = result.pagination;
        state.archiveFilteredOverview = result.overview;
        for (const article of result.items) {
          const existingIndex = state.articles.findIndex((item) => String(item.id) === String(article.id));
          if (existingIndex >= 0) state.articles[existingIndex] = article;
          else state.articles.push(article);
        }
        html = renderArchive(route);
      } catch (error) {
        console.warn("Archive API unavailable", error);
        if (version !== state.routeVersion) return;
        state.archiveItems = [];
        state.archivePagination = { page: 1, pageSize: 25, total: 0, totalPages: 0 };
        state.archiveFilteredOverview = null;
        html = `<div class="content-page"><div class="page-width"><div class="error-state"><div><i data-lucide="triangle-alert" aria-hidden="true"></i><h2>政策库暂时无法读取</h2><p>为避免展示不完整或未经核验的数据，本次没有使用本地估算结果。</p></div></div></div></div>`;
      }
    } else if (route === "about") {
      html = renderAbout();
    } else {
      html = renderHome();
    }

    elements.app.innerHTML = html;
    elements.app.hidden = false;
    elements.loading.hidden = true;
    updateActiveNav(route);
    closeMobileMenu();
    renderIcons();
    bindViewControls();
    if (articleForView) recordArticleView(articleForView.id);
    if (!preserveScroll) window.scrollTo({ top: 0, behavior: "instant" });
    const routeTitles = { home: "政策跟踪与复盘", archive: "政策库", tracking: "落地追踪", outlook: "前瞻研判", about: "方法说明" };
    document.title = ["articles", "listen"].includes(route) && parts[1]
      ? `${state.articles.find((item) => item.id === parts[1])?.title || "政策分析"} · 政知镜`
      : `${routeTitles[route] || routeTitles.home} · 政知镜`;
  }

  function bindViewControls() {
    bindArticleCoverFallbacks(elements.app);
    const archiveSearch = document.querySelector("#archive-search");
    const categoryFilter = document.querySelector("#category-filter");
    const statusFilter = document.querySelector("#status-filter");
    const eraFilter = document.querySelector("#era-filter");
    const currentRoute = routeInfo().parts[0] || "archive";
    const updateArchiveLocation = (updates = {}) => {
      const params = new URLSearchParams();
      const next = {
        q: state.query,
        category: state.category,
        status: state.status,
        era: state.era,
        ...updates
      };
      if (next.q) params.set("q", next.q);
      if (next.category && next.category !== "all") params.set("category", next.category);
      if (next.status && next.status !== "all") params.set("status", next.status);
      if (next.era && next.era !== "all") params.set("era", next.era);
      const target = `#/${currentRoute}${params.size ? `?${params}` : ""}`;
      if (location.hash === target) renderRoute({ preserveScroll: true });
      else location.hash = target;
    };
    let searchTimer;
    archiveSearch?.addEventListener("input", (event) => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.query = event.target.value;
        updateArchiveLocation({ q: state.query });
      }, 220);
    });
    categoryFilter?.addEventListener("change", (event) => {
      state.category = event.target.value;
      updateArchiveLocation({ category: state.category });
    });
    statusFilter?.addEventListener("change", (event) => {
      state.status = event.target.value;
      updateArchiveLocation({ status: state.status });
    });
    eraFilter?.addEventListener("change", (event) => {
      state.era = event.target.value;
      updateArchiveLocation({ era: state.era });
    });
    bindAudioControls();
  }

  function openSearch() {
    elements.searchDrawer.hidden = false;
    window.setTimeout(() => elements.searchInput.focus(), 0);
  }

  function closeSearch() {
    elements.searchDrawer.hidden = true;
  }

  function closeMobileMenu() {
    elements.mobileMenu.hidden = true;
    elements.menuToggle.setAttribute("aria-expanded", "false");
  }

  function toggleMobileMenu() {
    const willOpen = elements.mobileMenu.hidden;
    elements.mobileMenu.hidden = !willOpen;
    elements.menuToggle.setAttribute("aria-expanded", String(willOpen));
  }

  function showToast(message, isError = false) {
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { elements.toast.hidden = true; }, 4200);
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function supportsPush() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function isInstalled() {
    return isStandalone() || localStorage.getItem("policy-app-installed") === "true";
  }

  function updateInstallEntries() {
    const installed = isInstalled();
    elements.installButtons.forEach((button) => {
      button.hidden = installed;
      button.setAttribute("aria-label", installed ? "已添加到设备" : "添加到设备");
      button.title = installed ? "已添加到设备" : "添加到设备";
    });
    if (installed && elements.installDialog.open) closeInstallDialog();
  }

  function updatePushGuide() {
    const ios = isIOS();
    const standalone = isStandalone();
    if (ios && !standalone) {
      elements.deviceGuide.innerHTML = `<strong>iPhone / iPad 需要先添加到主屏幕</strong><ol><li>点击 Safari 底部的分享按钮</li><li>选择“添加到主屏幕”</li><li>从主屏幕打开政知镜，再点击订阅提醒</li></ol>`;
      elements.enablePush.querySelector("span").textContent = "检查通知条件";
    } else if (!supportsPush()) {
      elements.deviceGuide.innerHTML = `<strong>当前浏览器不支持网页通知</strong><span>请使用最新版 Safari、Chrome 或 Edge 打开此页面。</span>`;
      elements.enablePush.querySelector("span").textContent = "通知暂不可用";
    } else if (Notification.permission === "denied") {
      elements.deviceGuide.innerHTML = `<strong>通知权限已被关闭</strong><span>请在系统或浏览器的网站设置中允许通知，然后重新打开页面。</span>`;
      elements.enablePush.querySelector("span").textContent = "重新检查权限";
    } else {
      elements.deviceGuide.innerHTML = `<strong>${ios ? "Apple 设备" : "Android / 桌面设备"}</strong><span>授权后，仅在重要政策发布或历史判断发生关键变化时收到提醒。</span>`;
      elements.enablePush.querySelector("span").textContent = Notification.permission === "granted" ? "确认订阅状态" : "开启通知";
    }
    elements.installApp.hidden = isInstalled() || (!state.deferredInstallPrompt && !isIOS());
  }

  function openPushDialog() {
    updatePushGuide();
    if (typeof elements.pushDialog.showModal === "function") elements.pushDialog.showModal();
    else elements.pushDialog.setAttribute("open", "");
    document.body.classList.add("dialog-open");
    renderIcons();
  }

  function closePushDialog() {
    if (typeof elements.pushDialog.close === "function") elements.pushDialog.close();
    else elements.pushDialog.removeAttribute("open");
    document.body.classList.remove("dialog-open");
  }

  function updateInstallDialog() {
    if (isInstalled()) {
      elements.installDialogGuide.innerHTML = `<strong>已添加到设备</strong><span>可以直接从桌面或应用列表打开政知镜。</span>`;
      elements.installDialogAction.hidden = true;
      return;
    }

    if (isIOS()) {
      elements.installDialogGuide.innerHTML = `<strong>Safari 分享 → 添加到主屏幕</strong><span>添加后从主屏幕打开，即可继续开启政策通知。</span>`;
      elements.installDialogAction.hidden = true;
      return;
    }

    if (state.deferredInstallPrompt) {
      elements.installDialogGuide.innerHTML = `<strong>设备已满足安装条件</strong><span>点击下方按钮即可添加，不会安装额外插件。</span>`;
      elements.installDialogAction.hidden = false;
      return;
    }

    elements.installDialogGuide.innerHTML = `<strong>暂未出现安装选项</strong><span>请确认正在使用最新版 Chrome 或 Edge，并通过 HTTPS 访问。</span>`;
    elements.installDialogAction.hidden = true;
  }

  function openInstallDialog() {
    updateInstallDialog();
    if (typeof elements.installDialog.showModal === "function") elements.installDialog.showModal();
    else elements.installDialog.setAttribute("open", "");
    document.body.classList.add("dialog-open");
    renderIcons();
  }

  function closeInstallDialog() {
    if (typeof elements.installDialog.close === "function") elements.installDialog.close();
    else elements.installDialog.removeAttribute("open");
    document.body.classList.remove("dialog-open");
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    const registration = await navigator.serviceWorker.register(assetUrl("sw.js"), {
      scope: BASE_URL.pathname,
      updateViaCache: "none"
    });
    registration.update().catch(() => {});
    return registration;
  }

  async function enablePushNotifications() {
    if (isIOS() && !isStandalone()) {
      showToast("请先用 Safari 将页面添加到主屏幕，再从主屏幕打开。", true);
      return;
    }
    if (!supportsPush()) {
      showToast("当前浏览器不支持 Web Push 通知。", true);
      return;
    }
    if (Notification.permission === "denied") {
      showToast("通知权限已关闭，请先在浏览器的网站设置中允许通知。", true);
      return;
    }

    const originalLabel = elements.enablePush.querySelector("span").textContent;
    elements.enablePush.disabled = true;
    elements.enablePush.querySelector("span").textContent = "正在订阅…";
    try {
      const registration = await registerServiceWorker();
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("未获得通知权限");

      const keyPayload = await fetchJSON(apiUrl("push/public-key"));
      const publicKey = typeof keyPayload === "string"
        ? keyPayload
        : keyPayload.publicKey || keyPayload.public_key || keyPayload.vapidPublicKey || keyPayload.data?.publicKey;
      if (!publicKey) throw new Error("服务器尚未配置通知公钥");

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      const response = await fetch(apiUrl("push/subscribe"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          userAgent: navigator.userAgent,
          platform: isIOS() ? "ios" : (/android/i.test(navigator.userAgent) ? "android" : "desktop"),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });
      if (!response.ok) throw new Error(`订阅保存失败（${response.status}）`);
      localStorage.setItem("policy-push-subscribed", "true");
      closePushDialog();
      showToast("通知已开启。新政策或关键复盘变化会及时提醒你。");
      document.querySelectorAll("#push-button, #mobile-push-button").forEach((button) => button.classList.add("is-subscribed"));
    } catch (error) {
      console.error("Push subscription failed", error);
      showToast(error.message || "通知订阅失败，请稍后再试。", true);
      updatePushGuide();
    } finally {
      elements.enablePush.disabled = false;
      if (elements.pushDialog.open) elements.enablePush.querySelector("span").textContent = originalLabel;
    }
  }

  async function installApp() {
    if (isInstalled()) {
      updateInstallEntries();
      showToast("政知镜已经添加到这台设备。");
      return;
    }
    if (isIOS() || !state.deferredInstallPrompt) {
      openInstallDialog();
      return;
    }

    const prompt = state.deferredInstallPrompt;
    if (elements.pushDialog.open) closePushDialog();
    if (elements.installDialog.open) closeInstallDialog();
    prompt.prompt();
    const choice = await prompt.userChoice;
    state.deferredInstallPrompt = null;
    if (choice.outcome === "accepted") {
      localStorage.setItem("policy-app-installed", "true");
      updateInstallEntries();
      showToast("政知镜已添加到设备。");
    }
    updatePushGuide();
  }

  function bindShell() {
    document.querySelector("#search-toggle").addEventListener("click", openSearch);
    document.querySelector("#search-close").addEventListener("click", closeSearch);
    elements.menuToggle.addEventListener("click", toggleMobileMenu);
    document.querySelectorAll("#push-button, #mobile-push-button").forEach((button) => button.addEventListener("click", openPushDialog));
    elements.installButtons.forEach((button) => button.addEventListener("click", installApp));
    document.querySelector("#push-dialog-close").addEventListener("click", closePushDialog);
    elements.pushDialog.addEventListener("click", (event) => {
      if (event.target === elements.pushDialog) closePushDialog();
    });
    elements.enablePush.addEventListener("click", enablePushNotifications);
    elements.installApp.addEventListener("click", installApp);
    document.querySelector("#install-dialog-close").addEventListener("click", closeInstallDialog);
    elements.installDialog.addEventListener("click", (event) => {
      if (event.target === elements.installDialog) closeInstallDialog();
    });
    elements.installDialogAction.addEventListener("click", installApp);
    document.querySelector("#global-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      state.query = elements.searchInput.value.trim();
      closeSearch();
      const target = `#/archive${state.query ? `?q=${encodeURIComponent(state.query)}` : ""}`;
      if (location.hash === target) renderRoute();
      else location.hash = target;
    });
    window.addEventListener("hashchange", () => renderRoute());
    window.addEventListener("pagehide", () => stopAudioPlayback());
    window.addEventListener("pageshow", () => updateAudioPlayerUI());
    const audioViewport = window.matchMedia("(max-width: 820px)");
    const handleAudioViewportChange = () => {
      if (routeInfo().parts[0] === "listen") renderRoute();
    };
    if (typeof audioViewport.addEventListener === "function") audioViewport.addEventListener("change", handleAudioViewportChange);
    else audioViewport.addListener?.(handleAudioViewportChange);
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      if (elements.pushDialog.open) updatePushGuide();
      if (elements.installDialog.open) updateInstallDialog();
      updateInstallEntries();
    });
    window.addEventListener("appinstalled", () => {
      state.deferredInstallPrompt = null;
      localStorage.setItem("policy-app-installed", "true");
      updateInstallEntries();
      showToast("政知镜已安装到设备。");
    });
    window.matchMedia("(display-mode: standalone)").addEventListener?.("change", updateInstallEntries);
  }

  window.__POLICY_AUDIO_TEST__ = Object.freeze({
    normalizeSpeechText,
    extractNarrationText,
    normalizeArticle,
    segmentSpeechText,
    findSpeechPosition,
    getAdjacentArticleIds,
    neighborArticleId,
    estimateSpeechSeconds,
    formatSpeechTime
  });

  window.__POLICY_VIEW_TEST__ = Object.freeze({
    VISITOR_STORAGE_KEY,
    generateVisitorId,
    isValidVisitorId,
    readOrCreateVisitorId,
    normalizeViews,
    normalizeViewResponse,
    mergeViews,
    formatViewNumber,
    viewCountText,
    normalizeArticleViewId,
    createViewRequestBody,
    normalizeArticle
  });

  window.__POLICY_IMAGE_TEST__ = Object.freeze({
    FALLBACK_IMAGE,
    applyCoverImageFallback,
    bindArticleCoverFallbacks
  });

  async function boot() {
    bindShell();
    recordSiteView();
    const now = new Date();
    document.querySelector("#current-date").textContent = `${formatDate(now)} · 政策动态持续更新`;
    document.querySelector("#sync-time").textContent = `本次载入 ${formatDateTime(now)}`;
    renderIcons();
    updateInstallEntries();

    registerServiceWorker().catch((error) => console.warn("Service worker registration failed", error));
    try {
      const [articleResult, categoryResult, overviewResult] = await Promise.allSettled([
        fetchRecentArticles(),
        fetchJSON(apiUrl("categories")),
        fetchArchiveOverview()
      ]);
      const articles = articleResult.status === "fulfilled" ? articleResult.value : [];
      if (!articles.length) throw new Error("暂无可用 API 数据");
      state.articles = articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      state.categories = categoryResult.status === "fulfilled"
        ? extractCategories(categoryResult.value, state.articles)
        : extractCategories([], state.articles);
      state.archiveOverview = overviewResult.status === "fulfilled"
        ? overviewResult.value
        : overviewFromArticles(state.articles);
    } catch (error) {
      console.warn("Using frontend demonstration data", error);
      state.usingFallback = true;
      state.articles = FALLBACK_ARTICLES.map(normalizeArticle).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      state.categories = extractCategories([], state.articles);
      state.archiveOverview = overviewFromArticles(state.articles);
    }

    await renderRoute();
    if (localStorage.getItem("policy-push-subscribed") === "true") {
      document.querySelectorAll("#push-button, #mobile-push-button").forEach((button) => button.classList.add("is-subscribed"));
    }
  }

  boot().catch((error) => {
    console.error(error);
    elements.loading.hidden = true;
    elements.app.hidden = false;
    elements.app.innerHTML = `<div class="content-page"><div class="page-width"><div class="error-state"><div><i data-lucide="triangle-alert" aria-hidden="true"></i><h2>页面载入失败</h2><p>请刷新页面；若问题持续，请检查服务状态。</p></div></div></div></div>`;
    renderIcons();
  });
})();
