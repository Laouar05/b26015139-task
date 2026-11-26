/* ==========================================================================
   澄序 · Task Studio — Frontend Controller
   ========================================================================== */

const API_URL = "/api/tasks";
const RECOMMEND_URL = "/api/recommendations/today";
const CHAT_URL = "/api/chat";
const RING_CIRCUMFERENCE = 2 * Math.PI * 29; // r = 29 => ~182.212

const SORT_MODES = [
  { id: "newest", label: "最新创建" },
  { id: "oldest", label: "最早创建" },
  { id: "active_first", label: "未完成优先" },
];

const VIEW_TITLES = {
  all: "全部任务",
  active: "进行中",
  completed: "已完成",
};

const GENERAL_STARTERS = [
  "帮我规划一下今天高效专注的时间块",
  "面对不想开始的复杂任务，怎么克服拖延？",
  "给我一套简短的每日晚间复盘清单",
];

const TASK_STARTERS = [
  "这项计划最容易上手的第一步是什么？",
  "推进过程中可能遇到哪些坑或风险？",
  "帮我定义清晰的完成标准（验收清单）",
];

/* ---------- App State ---------- */
let allTasks = [];
let currentFilter = "all";
let searchQuery = "";
let sortIndex = 0;
let editingId = null;
let pendingDeleteTask = null;
let toastTimer = null;
let taskLoadVersion = 0;

/* ---------- DOM References ---------- */
const greetingText = document.getElementById("greeting-text");
const todayDate = document.getElementById("today-date");
const viewTitle = document.getElementById("view-title");

const progressRingFill = document.getElementById("progress-ring-fill");
const progressPercent = document.getElementById("progress-percent");
const taskCount = document.getElementById("task-count");
const statActive = document.getElementById("stat-active");
const statDone = document.getElementById("stat-done");
const badgeAll = document.getElementById("badge-all");
const badgeActive = document.getElementById("badge-active");
const badgeCompleted = document.getElementById("badge-completed");

const filterButtons = document.querySelectorAll(".filter-btn");
const searchField = document.querySelector(".search-field");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const clearSearchBtn = document.getElementById("clear-search-btn");
const sortToggle = document.getElementById("sort-toggle");
const sortLabel = document.getElementById("sort-label");

const composerCard = document.getElementById("composer-card");
const taskForm = document.getElementById("task-form");
const titleInput = document.getElementById("title-input");
const descInput = document.getElementById("desc-input");
const titleCounter = document.getElementById("title-counter");
const composerCancel = document.getElementById("composer-cancel");

const listMetaText = document.getElementById("list-meta-text");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const emptyTitle = document.getElementById("empty-title");
const emptySubtitle = document.getElementById("empty-subtitle");

// AI Studio Tabs & Panels
const aiTabs = document.querySelectorAll("[data-ai-tab]");
const aiShortcuts = document.querySelectorAll("[data-ai-jump]");
const panelRecommend = document.getElementById("panel-recommend");
const panelBreakdown = document.getElementById("panel-breakdown");

// Recommend
const recommendForm = document.getElementById("recommend-form");
const recommendContext = document.getElementById("recommend-context");
const recommendSubmit = document.getElementById("recommend-submit");
const recommendStatus = document.getElementById("recommend-status");
const recommendResults = document.getElementById("recommend-results");

// Breakdown
const breakdownForm = document.getElementById("breakdown-form");
const breakdownGoal = document.getElementById("breakdown-goal");
const breakdownGenerate = document.getElementById("breakdown-generate");
const breakdownStatus = document.getElementById("breakdown-status");
const breakdownSaveForm = document.getElementById("breakdown-save-form");
const breakdownSave = document.getElementById("breakdown-save");
const breakdownResults = document.getElementById("breakdown-results");
const draftCountLabel = document.getElementById("draft-count-label");
const draftClearAll = document.getElementById("draft-clear-all");
let draftGoal = null;
let breakdownBusy = false;

// Edit Modal
const editModal = document.getElementById("edit-modal");
const editForm = document.getElementById("edit-form");
const editTitle = document.getElementById("edit-title");
const editDesc = document.getElementById("edit-desc");
const editCancel = document.getElementById("edit-cancel");
const editCloseX = document.getElementById("edit-close-x");

// Delete Confirm Modal
const confirmModal = document.getElementById("confirm-modal");
const confirmDesc = document.getElementById("confirm-desc");
const confirmCancel = document.getElementById("confirm-cancel");
const confirmOk = document.getElementById("confirm-ok");

// Slide-Over AI Chat Drawer
const chatBackdrop = document.getElementById("chat-backdrop");
const chatDrawer = document.getElementById("chat-drawer");
const chatHeading = document.getElementById("chat-heading");
const chatSubtitle = document.getElementById("chat-subtitle");
const chatTurnBadge = document.getElementById("chat-turn-badge");
const chatContextCard = document.getElementById("chat-context-card");
const chatContextStatus = document.getElementById("chat-context-status");
const chatContextTitle = document.getElementById("chat-context-title");
const chatContextDesc = document.getElementById("chat-context-desc");
const chatNote = document.getElementById("chat-note");
const chatBody = document.getElementById("chat-body");
const chatEmpty = document.getElementById("chat-empty");
const chatEmptyTitle = document.getElementById("chat-empty-title");
const chatEmptyDesc = document.getElementById("chat-empty-desc");
const chatStarters = document.getElementById("chat-starters");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatReset = document.getElementById("chat-reset");
const chatClose = document.getElementById("chat-close");
const chatStatus = document.getElementById("chat-status");

const toastEl = document.getElementById("toast");

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;

  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay) return `今天 ${hh}:${mm}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hh}:${mm}`;

  const month = d.getMonth() + 1;
  const day = d.getDate();
  if (d.getFullYear() === now.getFullYear()) return `${month}月${day}日 ${hh}:${mm}`;
  return `${d.getFullYear()}/${month}/${day}`;
}

function initHeaderDate() {
  const now = new Date();
  const hour = now.getHours();
  let greeting = "你好";
  if (hour < 6) greeting = "夜深了";
  else if (hour < 11) greeting = "早安";
  else if (hour < 14) greeting = "午安";
  else if (hour < 18) greeting = "下午好";
  else greeting = "晚上好";

  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  greetingText.textContent = greeting;
  todayDate.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · ${weekdays[now.getDay()]}`;
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (type !== "info" ? ` ${type}` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 2600);
}

function setButtonLoading(btn, loading, loadingText, idleText) {
  btn.disabled = loading;
  btn.classList.toggle("is-loading", loading);
  const label = btn.querySelector(".btn-label");
  if (label && loadingText && idleText) {
    label.textContent = loading ? loadingText : idleText;
  }
}

/* ---------- Theme System ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("chengxu-theme", theme);
  } catch (e) {}
}

document.querySelectorAll("[data-theme-set]").forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeSet));
});

document.getElementById("mobile-theme-btn")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

/* ---------- AI Studio Tabs ---------- */
function switchAiTab(tabName, shouldFocus = false) {
  if (!canUseTab(tabName)) return;
  const isRecommend = tabName === "recommend";
  aiTabs.forEach((tab) => {
    const active = tab.dataset.aiTab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  panelRecommend.classList.toggle("is-hidden", !isRecommend);
  panelBreakdown.classList.toggle("is-hidden", isRecommend);

  if (shouldFocus) {
    const studioEl = document.getElementById("ai-studio");
    studioEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      (isRecommend ? recommendContext : breakdownGoal).focus();
    }, 180);
  }
}

aiTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchAiTab(tab.dataset.aiTab));
});

aiShortcuts.forEach((btn) => {
  btn.addEventListener("click", () => switchAiTab(btn.dataset.aiJump, true));
});

// Preset chips
document.querySelectorAll("[data-recommend-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    recommendContext.value = chip.dataset.recommendPreset;
    recommendContext.focus();
  });
});

document.querySelectorAll("[data-breakdown-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    breakdownGoal.value = chip.dataset.breakdownPreset;
    breakdownGoal.dispatchEvent(new Event("input"));
    breakdownGoal.focus();
  });
});

/* ---------- Quick-Capture Composer ---------- */
function expandComposer() {
  composerCard.classList.add("is-expanded");
}

function collapseComposer(force = false) {
  if (!force && (titleInput.value.trim() || descInput.value.trim())) return;
  composerCard.classList.remove("is-expanded");
}

titleInput.addEventListener("focus", expandComposer);
descInput.addEventListener("focus", expandComposer);

titleInput.addEventListener("input", () => {
  const len = titleInput.value.length;
  titleCounter.textContent = `${len} / 200`;
  titleCounter.classList.toggle("is-warn", len >= 170);
});

descInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    taskForm.requestSubmit();
  }
});

composerCancel.addEventListener("click", () => {
  titleInput.value = "";
  descInput.value = "";
  titleCounter.textContent = "0 / 200";
  titleCounter.classList.remove("is-warn");
  collapseComposer(true);
  titleInput.blur();
});

document.addEventListener("click", (e) => {
  if (!composerCard.contains(e.target)) {
    collapseComposer(false);
  }
});

/* ---------- Data Loading, Filtering & Rendering ---------- */
function updateProgressAndBadges() {
  const total = allTasks.length;
  const done = allTasks.filter((t) => t.completed).length;
  const active = total - done;
  const pct = total ? Math.round((done / total) * 100) : 0;

  badgeAll.textContent = total;
  badgeActive.textContent = active;
  badgeCompleted.textContent = done;
  statActive.textContent = active;
  statDone.textContent = done;

  progressPercent.textContent = `${pct}%`;
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
  progressRingFill.style.strokeDashoffset = String(offset);

  if (total === 0) {
    taskCount.textContent = "开启清爽一天";
  } else if (done === total) {
    taskCount.textContent = "全部完成，干得漂亮";
  } else {
    taskCount.textContent = `已完成 ${done} / ${total} 项`;
  }
}

function getVisibleTasks() {
  let list = allTasks.slice();

  if (currentFilter === "active") {
    list = list.filter((t) => !t.completed);
  } else if (currentFilter === "completed") {
    list = list.filter((t) => t.completed);
  }

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q)
    );
  }

  const mode = SORT_MODES[sortIndex].id;
  list.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (mode === "oldest") return ta - tb || a.id - b.id;
    if (mode === "active_first") {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return tb - ta || b.id - a.id;
    }
    return tb - ta || b.id - a.id;
  });

  return list;
}

function renderTaskList() {
  const visible = getVisibleTasks();
  const q = searchQuery.trim();

  viewTitle.textContent = VIEW_TITLES[currentFilter] || "全部任务";
  searchField.classList.toggle("has-query", !!q);
  searchClear.classList.toggle("is-hidden", !q);
  clearSearchBtn.classList.toggle("is-hidden", !q);

  if (q) {
    listMetaText.textContent = `搜索 “${q}” · 找到 ${visible.length} 项`;
  } else {
    listMetaText.textContent = visible.length ? `共 ${visible.length} 项任务` : "暂无匹配项";
  }

  taskList.replaceChildren(...visible.map(buildTaskItem));

  const isEmpty = visible.length === 0;
  emptyState.classList.toggle("is-hidden", !isEmpty);

  if (isEmpty) {
    if (q) {
      emptyTitle.textContent = "没有找到相关任务";
      emptySubtitle.textContent = `未找到包含「${q}」的任务，试试更换关键词或清除筛选。`;
    } else if (currentFilter === "completed") {
      emptyTitle.textContent = "尚未勾选完成项";
      emptySubtitle.textContent = "完成第一项待办后，它会安静地记录在这里。";
    } else if (currentFilter === "active") {
      emptyTitle.textContent = "所有待办已清空";
      emptySubtitle.textContent = "此刻轻松自在 — 享受这份完成感，或开启下一段计划。";
    } else {
      emptyTitle.textContent = "此刻清净无事";
      emptySubtitle.textContent = "在上方输入框写下第一个待办，或用右侧 AI 拆解一个大目标。";
    }
  }
}

function buildTaskItem(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.completed ? " is-completed" : "");
  li.dataset.id = task.id;
  li.id = `task-${task.id}`;
  li.tabIndex = -1;

  const relTime = formatRelativeTime(task.created_at);
  const fullTime = task.created_at ? new Date(task.created_at).toLocaleString("zh-CN") : "";

  li.innerHTML = `
    <button
      type="button"
      class="task-check-btn"
      role="checkbox"
      aria-checked="${task.completed ? "true" : "false"}"
      aria-label="${task.completed ? "标记为未完成" : "标记为已完成"}"
      title="${task.completed ? "标记为未完成" : "标记为已完成"}"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </button>
    <div class="task-body">
      <div class="task-title">${escapeHtml(task.title)}</div>
      ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ""}
      <div class="task-meta">
        ${
          relTime
            ? `<span class="meta-time" title="创建于 ${escapeHtml(fullTime)}">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                   <circle cx="12" cy="12" r="9" />
                   <polyline points="12 7 12 12 15 14" />
                 </svg>
                 ${escapeHtml(relTime)}
               </span>`
            : ""
        }
        ${task.completed ? `<span class="meta-done-tag">已完成</span>` : ""}
      </div>
    </div>
    <div class="task-actions">
      <button type="button" class="task-action-chat" title="围绕此计划与 AI 深聊">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3z" />
        </svg>
        <span>聊计划</span>
      </button>
      <button type="button" class="task-icon-btn edit-btn" title="编辑任务" aria-label="编辑任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
      <button type="button" class="task-icon-btn is-danger delete-btn" title="删除任务" aria-label="删除任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  `;

  const writable = mayWriteTask(task);
  const toggle = li.querySelector('.task-check-btn');
  toggle.disabled = !writable;
  if (!writable) {
    toggle.setAttribute('aria-label', task.completed ? '已完成' : '未完成');
    toggle.title = '只读任务';
  }
  const edit = li.querySelector('.edit-btn');
  const remove = li.querySelector('.delete-btn');
  const chat = li.querySelector('.task-action-chat');
  edit.hidden = remove.hidden = !writable;
  chat.hidden = !hasPermissions('ai:chat', 'task:read');
  toggle.addEventListener('click', () => toggleTask(task.id));
  chat.addEventListener('click', () => openChat(task));
  edit.addEventListener('click', () => openEditModal(task));
  remove.addEventListener('click', () => openDeleteConfirm(task));
  if (hasPermissions('task:assign', 'task:read', 'task:write', 'task:read_all', 'task:write_all', 'user:manage')) {
    const transfer = document.createElement('button');
    transfer.type = 'button';
    transfer.className = 'task-action-transfer';
    transfer.title = '将此任务转交给其他用户';
    transfer.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
      <span>转交</span>
    `;
    transfer.addEventListener('click', () => openTransfer(task));
    li.querySelector('.task-actions').append(transfer);
  }

  return li;
}

async function loadTasks() {
  const version = ++taskLoadVersion;
  try {
    const tasks = await request(`${API_URL}?status=all`);
    if (version !== taskLoadVersion) return;
    allTasks = Array.isArray(tasks) ? tasks : [];
    updateProgressAndBadges();
    renderTaskList();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (version !== taskLoadVersion) return;
    showToast("加载任务失败：" + err.message, "error");
    allTasks = [];
    updateProgressAndBadges();
    renderTaskList();
  }
}

function changeFilter(filter) {
  currentFilter = filter;
  filterButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.filter === filter);
  });
  renderTaskList();
}

/* ---------- Task CRUD Actions ---------- */
async function addTask(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const description = descInput.value.trim();
  if (!title) {
    showToast("请输入任务标题", "error");
    titleInput.focus();
    return;
  }
  try {
    const created = await request(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    titleInput.value = "";
    descInput.value = "";
    titleCounter.textContent = "0 / 200";
    titleCounter.classList.remove("is-warn");
    if (currentFilter === "completed") changeFilter("active");
    allTasks.unshift(created);
    updateProgressAndBadges();
    renderTaskList();
    showToast("已添加到任务清单", "success");
    titleInput.focus();
  } catch (err) {
    if (err.name === 'AbortError') return;
    showToast(err.message, "error");
  }
}

async function toggleTask(id) {
  const target = allTasks.find((t) => t.id === id);
  if (!target) return;
  const prev = target.completed;
  target.completed = !prev;
  updateProgressAndBadges();
  renderTaskList();
  try {
    const updated = await request(`${API_URL}/${id}/toggle`, { method: "PATCH" });
    Object.assign(target, updated);
    updateProgressAndBadges();
    renderTaskList();
    if (target.completed) {
      showToast("已完成一项任务", "success");
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    target.completed = prev;
    updateProgressAndBadges();
    renderTaskList();
    showToast(err.message, "error");
  }
}

/* ---------- Edit Modal ---------- */
function openEditModal(task) {
  editingId = task.id;
  editTitle.value = task.title;
  editDesc.value = task.description || "";
  editModal.classList.remove("is-hidden");
  editTitle.focus();
  editTitle.setSelectionRange(editTitle.value.length, editTitle.value.length);
}

function closeEditModal() {
  editingId = null;
  editModal.classList.add("is-hidden");
}

async function saveEdit(event) {
  event.preventDefault();
  const title = editTitle.value.trim();
  if (!title) {
    showToast("标题不能为空", "error");
    editTitle.focus();
    return;
  }
  try {
    const updated = await request(`${API_URL}/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: editDesc.value.trim() }),
    });
    const idx = allTasks.findIndex((t) => t.id === editingId);
    if (idx !== -1) allTasks[idx] = updated;
    updateProgressAndBadges();
    renderTaskList();
    closeEditModal();
    showToast("任务已更新", "success");
  } catch (err) {
    if (err.name === 'AbortError') return;
    showToast(err.message, "error");
  }
}

/* ---------- Delete Confirmation Modal ---------- */
function openDeleteConfirm(task) {
  pendingDeleteTask = task;
  confirmDesc.textContent = `将永久删除「${task.title}」，此操作无法撤销。`;
  confirmModal.classList.remove("is-hidden");
  confirmOk.focus();
}

function closeDeleteConfirm() {
  pendingDeleteTask = null;
  confirmModal.classList.add("is-hidden");
}

async function executeDelete() {
  if (!pendingDeleteTask) return;
  const id = pendingDeleteTask.id;
  closeDeleteConfirm();
  try {
    await request(`${API_URL}/${id}`, { method: "DELETE" });
    allTasks = allTasks.filter((t) => t.id !== id);
    if (activeChat?.taskId === id) {
      closeChatDrawer();
      activeChat = null;
    }
    chatThreads.delete(id);
    updateProgressAndBadges();
    renderTaskList();
    showToast("任务已删除", "success");
  } catch (err) {
    if (err.name === 'AbortError') return;
    showToast(err.message, "error");
  }
}

/* ---------- Today's AI Recommendations ---------- */
async function generateRecommendations(event) {
  event.preventDefault();
  if (recommendSubmit.disabled || !canUseTab('recommend')) return;
  const includeAll = document.getElementById('recommend-scope').checked && hasPermissions('task:read_all');
  if (includeAll && !window.confirm('将把其他用户的未完成任务发送给已配置的模型供应商。继续？')) return;
  setButtonLoading(recommendSubmit, true, "正在分析排期…", "生成行动建议");
  recommendStatus.textContent = "正在结合未完成任务与当下状态分析…";
  recommendStatus.className = "status-banner";
  recommendResults.replaceChildren();

  try {
    const { recommendations } = await request(RECOMMEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: recommendContext.value.trim(), scope: includeAll ? 'all' : 'own' }),
    });

    if (!recommendations.length) {
      recommendStatus.textContent = "当前没有未完成的任务，可以轻松休息一下。";
      recommendStatus.className = "status-banner is-success";
      return;
    }

    recommendStatus.textContent = `已为你挑出 ${recommendations.length} 项最值得优先推进的任务：`;
    recommendStatus.className = "status-banner is-success";

    recommendations.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = "recommend-card-item" + (index === 0 ? " is-primary" : "");

      const badge = document.createElement("span");
      badge.className = "rec-badge";
      badge.textContent = index === 0 ? "01 · 首要推荐" : `0${index + 1} · 顺位跟进`;

      const heading = document.createElement("div");
      const link = document.createElement("a");
      link.href = `#task-${item.task_id}`;
      link.className = "rec-title-link";
      link.innerHTML = `<span>${escapeHtml(item.title)}</span><span class="rec-jump-arrow" aria-hidden="true">↗</span>`;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        jumpToTask(item.task_id);
      });
      heading.appendChild(link);

      const reason = document.createElement("p");
      reason.className = "rec-reason";
      reason.textContent = item.reason;

      const stepBox = document.createElement("div");
      stepBox.className = "rec-step-box";
      stepBox.innerHTML = `<span class="rec-step-label">第一步</span>${escapeHtml(item.first_step)}`;

      li.append(badge, heading, reason, stepBox);
      recommendResults.appendChild(li);
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    recommendStatus.textContent = err.message;
    recommendStatus.className = "status-banner is-error";
  } finally {
    setButtonLoading(recommendSubmit, false, "正在分析排期…", "生成行动建议");
  }
}

function jumpToTask(id) {
  let item = document.getElementById(`task-${id}`);
  if (!item) {
    if (searchQuery) {
      searchQuery = "";
      searchInput.value = "";
    }
    if (currentFilter !== "all") {
      changeFilter("all");
    } else {
      renderTaskList();
    }
    item = document.getElementById(`task-${id}`);
  }
  if (!item) {
    showToast("该任务不在列表中，可能已被删除。", "error");
    return;
  }
  item.classList.remove("is-highlighted");
  void item.offsetWidth;
  item.classList.add("is-highlighted");
  item.focus({ preventScroll: true });
  item.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => item.classList.remove("is-highlighted"), 2000);
}

/* ---------- AI Task Decomposition ---------- */
function setBreakdownStatus(message, type = "info") {
  breakdownStatus.textContent = message;
  breakdownStatus.className =
    "status-banner" + (type === "error" ? " is-error" : type === "success" ? " is-success" : "");
}

function renumberDrafts() {
  Array.from(breakdownResults.children).forEach((item, idx) => {
    const numEl = item.querySelector(".draft-step-num");
    if (numEl) numEl.textContent = `步骤 ${String(idx + 1).padStart(2, "0")}`;
  });
}

function updateBreakdownControls() {
  const count = breakdownResults.children.length;
  breakdownSaveForm.hidden = !count;
  breakdownGenerate.disabled = breakdownBusy;
  breakdownGoal.readOnly = breakdownBusy;
  draftCountLabel.textContent = `待确认草稿 · ${count} 项`;
  const saveLabel = breakdownSave.querySelector(".btn-label");
  if (saveLabel && !breakdownBusy) {
    saveLabel.textContent = count ? `批量加入 ${count} 项任务` : "批量加入任务列表";
  }
  for (const field of breakdownSaveForm.elements) {
    field.disabled = breakdownBusy;
  }
  breakdownSave.disabled = breakdownBusy || !count || breakdownGoal.value.trim() !== draftGoal;
}

function buildTaskDraft(task, index) {
  const item = document.createElement("li");
  item.className = "draft-item";

  const head = document.createElement("div");
  head.className = "draft-item-head";

  const stepBadge = document.createElement("span");
  stepBadge.className = "draft-step-num";
  stepBadge.textContent = `步骤 ${String(index + 1).padStart(2, "0")}`;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "draft-remove-btn";
  remove.textContent = "×";
  remove.title = "移除此项草稿";
  remove.setAttribute("aria-label", `移除步骤 ${index + 1}`);
  remove.addEventListener("click", () => {
    const next = item.nextElementSibling || item.previousElementSibling;
    item.remove();
    renumberDrafts();
    updateBreakdownControls();
    if (!breakdownResults.children.length) {
      draftGoal = null;
      setBreakdownStatus("草稿已清空，可以重新生成。");
    }
    (next?.querySelector("input") || breakdownGoal).focus();
  });

  head.append(stepBadge, remove);

  const title = document.createElement("input");
  title.className = "field-input";
  title.name = "title";
  title.maxLength = 200;
  title.required = true;
  title.placeholder = "子任务标题";
  title.value = task.title;

  const description = document.createElement("textarea");
  description.className = "field-input field-textarea";
  description.name = "description";
  description.rows = 2;
  description.maxLength = 1000;
  description.placeholder = "具体做法或验收标准（选填）";
  description.value = task.description || "";

  item.append(head, title, description);
  return item;
}

async function generateTaskDrafts(event) {
  event.preventDefault();
  if (breakdownBusy) return;
  const goal = breakdownGoal.value.trim();
  if (!goal) {
    setBreakdownStatus("请先输入你想完成的大任务目标。", "error");
    return;
  }

  breakdownBusy = true;
  setButtonLoading(breakdownGenerate, true, "正在拆解目标…", "生成子任务草稿");
  updateBreakdownControls();
  setBreakdownStatus("正在梳理执行步骤…");

  try {
    const { tasks } = await request(`${API_URL}/decompose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    breakdownResults.replaceChildren(...tasks.map(buildTaskDraft));
    draftGoal = goal;
    setBreakdownStatus(`已拆解为 ${tasks.length} 步草稿，审阅后可一键批量加入。`, "success");
  } catch (err) {
    if (err.name === 'AbortError') return;
    setBreakdownStatus(err.message, "error");
  } finally {
    breakdownBusy = false;
    setButtonLoading(breakdownGenerate, false, "正在拆解目标…", "生成子任务草稿");
    updateBreakdownControls();
  }
}

async function saveTaskDrafts(event) {
  event.preventDefault();
  if (breakdownSave.disabled) return;
  const tasks = Array.from(breakdownResults.children, (item) => ({
    title: item.querySelector("input").value.trim(),
    description: item.querySelector("textarea").value.trim(),
  }));

  breakdownBusy = true;
  setButtonLoading(breakdownSave, true, "正在加入列表…", "批量加入任务列表");
  updateBreakdownControls();
  setBreakdownStatus("正在保存子任务…");

  try {
    const result = await request(`${API_URL}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
    breakdownResults.replaceChildren();
    breakdownGoal.value = "";
    draftGoal = null;
    const addedCount = result.tasks?.length || tasks.length;
    setBreakdownStatus(`已成功加入 ${addedCount} 项任务到清单。`, "success");
    showToast(`已批量加入 ${addedCount} 项子任务`, "success");
    if (currentFilter === "completed") changeFilter("active");
    await loadTasks();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setBreakdownStatus(err.message, "error");
  } finally {
    breakdownBusy = false;
    setButtonLoading(breakdownSave, false, "正在加入列表…", "批量加入任务列表");
    updateBreakdownControls();
    if (draftGoal === null) breakdownGoal.focus();
  }
}

draftClearAll.addEventListener("click", () => {
  if (breakdownBusy) return;
  breakdownResults.replaceChildren();
  draftGoal = null;
  updateBreakdownControls();
  setBreakdownStatus("草稿已清空。");
});

breakdownGoal.addEventListener("input", () => {
  updateBreakdownControls();
  if (draftGoal !== null) {
    setBreakdownStatus(
      breakdownSave.disabled ? "目标已修改，请重新生成子任务草稿。" : "可以继续编辑或确认保存草稿。"
    );
  }
});

/* ---------- Slide-Over AI Chat Drawer ---------- */
const chatThreads = new Map();
const CHAT_HISTORY_LIMIT = 16; // 8 turns
let activeChat = null;
let chatDrawerOpen = false;

function buildChatMessageEl(role, content) {
  const item = document.createElement("li");
  item.className = `chat-message chat-${role}`;

  const meta = document.createElement("div");
  meta.className = "chat-meta-row";

  const sender = document.createElement("span");
  sender.className = "chat-sender";
  sender.textContent = role === "user" ? "你" : "AI 助手";
  meta.appendChild(sender);

  if (role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "chat-copy-btn";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(content);
        copyBtn.textContent = "已复制";
        setTimeout(() => (copyBtn.textContent = "复制"), 1400);
      } catch (e) {
        showToast("复制失败", "error");
      }
    });
    meta.appendChild(copyBtn);
  }

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = content;

  item.append(meta, bubble);
  return item;
}

function buildTypingIndicatorEl() {
  const item = document.createElement("li");
  item.className = "chat-message chat-assistant";
  item.innerHTML = `
    <div class="chat-meta-row"><span class="chat-sender">AI 助手</span></div>
    <div class="chat-bubble typing-dots" aria-label="AI 正在思考">
      <span></span><span></span><span></span>
    </div>
  `;
  return item;
}

function renderChat(thread) {
  const messages = thread.messages.slice();
  const nodes = messages.map(({ role, content }) => buildChatMessageEl(role, content));
  if (thread.pending) {
    nodes.push(buildChatMessageEl("user", thread.draft));
    nodes.push(buildTypingIndicatorEl());
  }

  chatLog.replaceChildren(...nodes);
  const hasMessages = nodes.length > 0;
  chatLog.classList.toggle("is-hidden", !hasMessages);
  chatEmpty.classList.toggle("is-hidden", hasMessages);

  const turns = Math.floor(thread.messages.length / 2);
  chatTurnBadge.textContent = `${turns} / 8 轮`;

  chatInput.value = thread.pending ? "" : thread.draft;
  chatInput.readOnly = thread.pending;
  chatSend.disabled = thread.pending;
  chatReset.disabled = thread.pending || (!thread.messages.length && !thread.draft);

  chatStatus.textContent = thread.pending ? "AI 正在思考回复…" : thread.error;
  chatStatus.classList.toggle("is-error", !!thread.error);

  requestAnimationFrame(() => {
    chatBody.scrollTop = chatBody.scrollHeight;
  });
}

function renderChatStarters(isTaskChat) {
  const prompts = isTaskChat ? TASK_STARTERS : GENERAL_STARTERS;
  chatStarters.replaceChildren(
    ...prompts.map((text) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "starter-btn";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        if (!activeChat || activeChat.pending) return;
        chatInput.value = text;
        activeChat.draft = text;
        chatForm.requestSubmit();
      });
      return btn;
    })
  );
}

function openChat(task = null) {
  if (!hasPermissions('ai:chat') || task && !hasPermissions('task:read')) return;
  if (task && task.owner_id !== authState.user.id &&
      !window.confirm('将把这条任务的标题、描述和状态发送给已配置的模型供应商。继续？')) return;
  const taskId = task?.id ?? null;
  if (!chatThreads.has(taskId)) {
    chatThreads.set(taskId, { taskId, messages: [], draft: "", pending: false, error: "" });
  }
  activeChat = chatThreads.get(taskId);

  if (task) {
    // Always get latest task snapshot from allTasks if present
    const latest = allTasks.find((t) => t.id === task.id) || task;
    chatHeading.textContent = "计划深聊";
    chatSubtitle.textContent = "聚焦单条任务的执行策略";
    chatContextCard.classList.remove("is-hidden");
    chatContextTitle.textContent = latest.title;
    chatContextDesc.textContent = latest.description || "暂无详细描述";
    chatContextStatus.textContent = latest.completed ? "已完成" : "进行中";
    chatContextStatus.classList.toggle("is-done", !!latest.completed);
    chatNote.textContent = "仅发送近期对话与此任务的标题、描述及状态给模型，不会修改任务本身。";
    chatEmptyTitle.textContent = "聊聊怎么推进这件事";
    chatEmptyDesc.textContent = "可以拆解第一步、预判风险或讨论验收标准。";
  } else {
    chatHeading.textContent = "AI 对话助手";
    chatSubtitle.textContent = "自由讨论与时间规划";
    chatContextCard.classList.add("is-hidden");
    chatNote.textContent = "自由对话不会自动读取你的任务清单，刷新页面后记录会重置。";
    chatEmptyTitle.textContent = "随时开始讨论";
    chatEmptyDesc.textContent = "说说你正在纠结的安排，或点选下方快捷问题开始对话。";
  }

  renderChatStarters(!!task);
  renderChat(activeChat);

  chatBackdrop.classList.remove("is-hidden");
  chatDrawer.classList.remove("is-hidden");
  chatDrawerOpen = true;
  document.body.style.overflow = "hidden";
  setTimeout(() => chatInput.focus(), 80);
}

function closeChatDrawer() {
  chatDrawerOpen = false;
  chatBackdrop.classList.add("is-hidden");
  chatDrawer.classList.add("is-hidden");
  document.body.style.overflow = "";
}

chatInput.addEventListener("input", () => {
  if (!activeChat) return;
  activeChat.draft = chatInput.value;
  chatReset.disabled = activeChat.pending || (!activeChat.messages.length && !activeChat.draft);
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const thread = activeChat;
  const content = chatInput.value.trim();
  if (!thread || thread.pending || !content) return;

  const userMessage = { role: "user", content };
  thread.draft = content;
  thread.pending = true;
  thread.error = "";
  renderChat(thread);

  try {
    const { reply } = await request(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: thread.taskId,
        messages: [...thread.messages, userMessage],
      }),
    });
    if (typeof reply !== "string" || !reply.trim()) {
      throw new Error("没有收到有效回复，请重试。");
    }
    thread.messages = [
      ...thread.messages,
      userMessage,
      { role: "assistant", content: reply },
    ].slice(-CHAT_HISTORY_LIMIT);
    thread.draft = "";
  } catch (err) {
    if (err.name === 'AbortError') return;
    thread.error = err.message;
  } finally {
    thread.pending = false;
    if (chatDrawerOpen && activeChat === thread) {
      renderChat(thread);
      chatInput.focus();
    }
  }
});

chatReset.addEventListener("click", () => {
  if (!activeChat || activeChat.pending) return;
  activeChat.messages = [];
  activeChat.error = "";
  activeChat.draft = "";
  renderChat(activeChat);
  chatInput.focus();
  showToast("已清空当前对话");
});

document.getElementById("chat-open").addEventListener("click", () => openChat());
document.getElementById("mobile-chat-btn")?.addEventListener("click", () => openChat());
chatClose.addEventListener("click", closeChatDrawer);
chatBackdrop.addEventListener("click", closeChatDrawer);

/* ---------- Search, Sort & Global Shortcuts ---------- */
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderTaskList();
});

function clearSearch() {
  searchQuery = "";
  searchInput.value = "";
  renderTaskList();
}
searchClear.addEventListener("click", clearSearch);
clearSearchBtn.addEventListener("click", clearSearch);

sortToggle.addEventListener("click", () => {
  sortIndex = (sortIndex + 1) % SORT_MODES.length;
  sortLabel.textContent = SORT_MODES[sortIndex].label;
  renderTaskList();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!confirmModal.classList.contains("is-hidden")) {
      closeDeleteConfirm();
      return;
    }
    if (!editModal.classList.contains("is-hidden")) {
      closeEditModal();
      return;
    }
    if (chatDrawerOpen) {
      closeChatDrawer();
      return;
    }
    if (document.activeElement === searchInput && searchQuery) {
      clearSearch();
      return;
    }
    if (composerCard.contains(document.activeElement)) {
      collapseComposer(true);
      document.activeElement.blur();
    }
    return;
  }

  // Ignore single-key shortcuts when typing inside inputs/textareas
  const tag = document.activeElement?.tagName;
  const isTyping = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
  if (isTyping || chatDrawerOpen || !editModal.classList.contains("is-hidden") || !confirmModal.classList.contains("is-hidden")) {
    return;
  }

  if (e.key === "/") {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    expandComposer();
    titleInput.focus();
  }
});

/* ---------- Event Bindings & Bootstrap ---------- */
taskForm.addEventListener("submit", addTask);
recommendForm.addEventListener("submit", generateRecommendations);
breakdownForm.addEventListener("submit", generateTaskDrafts);
breakdownSaveForm.addEventListener("submit", saveTaskDrafts);

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => changeFilter(btn.dataset.filter));
});

editForm.addEventListener("submit", saveEdit);
editCancel.addEventListener("click", closeEditModal);
editCloseX.addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});

confirmCancel.addEventListener("click", closeDeleteConfirm);
confirmOk.addEventListener("click", executeDelete);
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeDeleteConfirm();
});

initHeaderDate();
