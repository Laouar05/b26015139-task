/* ---------- 任务管理器前端逻辑 ---------- */
const API_URL = "/api/tasks";

let currentFilter = "all";
let editingId = null;
let toastTimer = null;

// ----- DOM 元素 -----
const taskForm = document.getElementById("task-form");
const titleInput = document.getElementById("title-input");
const descInput = document.getElementById("desc-input");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const taskCount = document.getElementById("task-count");
const filterButtons = document.querySelectorAll(".filter-btn");

const editModal = document.getElementById("edit-modal");
const editTitle = document.getElementById("edit-title");
const editDesc = document.getElementById("edit-desc");
const editSave = document.getElementById("edit-save");
const editCancel = document.getElementById("edit-cancel");

const toastEl = document.getElementById("toast");

/* ---------- 辅助函数 ---------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("zh-CN");
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (type !== "info" ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = "toast"), 2500);
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 204) return null; // 无内容
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return data;
}

const RECOMMEND_URL = "/api/recommendations/today";

const recommendForm = document.getElementById("recommend-form");
const recommendContext = document.getElementById("recommend-context");
const recommendSubmit = document.getElementById("recommend-submit");
const recommendStatus = document.getElementById("recommend-status");
const recommendResults = document.getElementById("recommend-results");

/* ---------- 任务推荐 ---------- */
async function generateRecommendations(event) {
  event.preventDefault();
  if (recommendSubmit.disabled) return;
  recommendSubmit.disabled = true;
  recommendSubmit.textContent = "正在生成…";
  recommendStatus.textContent = "正在分析未完成任务…";
  recommendStatus.classList.remove("is-error");
  recommendResults.replaceChildren();
  try {
    const { recommendations } = await request(RECOMMEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: recommendContext.value.trim() }),
    });
    recommendStatus.textContent = recommendations.length ? "建议已生成。" : "没有未完成的任务。";
    recommendations.forEach((item, index) => {
      const result = document.createElement("li");
      result.className = "recommend-result";
      const heading = document.createElement("h3");
      const link = document.createElement("a");
      link.href = `#task-${item.task_id}`;
      link.textContent = item.title;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await jumpToTask(item.task_id);
      });
      heading.append(index === 0 ? "先做 · " : "接着做 · ", link);
      const reason = document.createElement("p");
      reason.textContent = item.reason;
      const firstStep = document.createElement("p");
      firstStep.textContent = `第一步 · ${item.first_step}`;
      result.append(heading, reason, firstStep);
      recommendResults.appendChild(result);
    });
  } catch (err) {
    recommendStatus.textContent = err.message;
    recommendStatus.classList.add("is-error");
  } finally {
    recommendSubmit.disabled = false;
    recommendSubmit.textContent = "生成建议";
  }
}

async function jumpToTask(id) {
  const itemId = `task-${id}`;
  let item = document.getElementById(itemId);
  if (!item && currentFilter !== "all") {
    await changeFilter("all");
    item = document.getElementById(itemId);
  }
  if (!item) {
    showToast("任务不在列表中，请刷新建议。", "error");
    return;
  }
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "center" });
}

/* ---------- AI 分解任务 ---------- */
const breakdownForm = document.getElementById("breakdown-form");
const breakdownGoal = document.getElementById("breakdown-goal");
const breakdownGenerate = document.getElementById("breakdown-generate");
const breakdownStatus = document.getElementById("breakdown-status");
const breakdownSaveForm = document.getElementById("breakdown-save-form");
const breakdownSave = document.getElementById("breakdown-save");
const breakdownResults = document.getElementById("breakdown-results");
let draftGoal = null;
let breakdownBusy = false;

function setBreakdownStatus(message, isError = false) {
  breakdownStatus.textContent = message;
  breakdownStatus.classList.toggle("is-error", isError);
}

function updateBreakdownControls() {
  const count = breakdownResults.children.length;
  breakdownSaveForm.hidden = !count;
  breakdownGenerate.disabled = breakdownBusy;
  breakdownGoal.readOnly = breakdownBusy;
  for (const field of breakdownSaveForm.elements) field.disabled = breakdownBusy;
  breakdownSave.disabled = breakdownBusy || !count || breakdownGoal.value.trim() !== draftGoal;
}

function buildTaskDraft(task, index) {
  const item = document.createElement("li");
  item.className = "recommend-result";
  const titleLabel = document.createElement("label");
  titleLabel.textContent = `任务 ${index + 1} · 标题`;
  const title = document.createElement("input");
  title.className = "input";
  title.name = "title";
  title.maxLength = 200;
  title.required = true;
  title.value = task.title;
  titleLabel.append(title);
  const descriptionLabel = document.createElement("label");
  descriptionLabel.textContent = "描述（选填）";
  const description = document.createElement("textarea");
  description.className = "input textarea";
  description.name = "description";
  description.rows = 2;
  description.maxLength = 1000;
  description.value = task.description;
  descriptionLabel.append(description);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-secondary";
  remove.textContent = "移除此项";
  remove.setAttribute("aria-label", `移除任务 ${index + 1}`);
  remove.addEventListener("click", () => {
    const next = item.nextElementSibling || item.previousElementSibling;
    item.remove();
    updateBreakdownControls();
    if (!breakdownResults.children.length) {
      draftGoal = null;
      setBreakdownStatus("草稿已清空，可以重新生成。");
    }
    (next?.querySelector("input") || breakdownGoal).focus();
  });
  item.append(titleLabel, descriptionLabel, remove);
  return item;
}

async function generateTaskDrafts(event) {
  event.preventDefault();
  if (breakdownBusy) return;
  const goal = breakdownGoal.value.trim();
  if (!goal) {
    setBreakdownStatus("请输入大任务目标。", true);
    return;
  }
  breakdownBusy = true;
  updateBreakdownControls();
  setBreakdownStatus("正在分解任务…");
  try {
    const { tasks } = await request(`${API_URL}/decompose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    breakdownResults.replaceChildren(...tasks.map(buildTaskDraft));
    draftGoal = goal;
    setBreakdownStatus("草稿已生成，可以修改或移除，再批量加入。");
  } catch (err) {
    setBreakdownStatus(err.message, true);
  } finally {
    breakdownBusy = false;
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
  updateBreakdownControls();
  setBreakdownStatus("正在保存任务…");
  try {
    const result = await request(`${API_URL}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
    breakdownResults.replaceChildren();
    breakdownGoal.value = "";
    draftGoal = null;
    setBreakdownStatus(`已加入 ${result.tasks.length} 项任务。`);
    if (currentFilter === "completed") await changeFilter("active");
    else await loadTasks();
  } catch (err) {
    setBreakdownStatus(err.message, true);
  } finally {
    breakdownBusy = false;
    updateBreakdownControls();
    if (draftGoal === null) breakdownGoal.focus();
  }
}

breakdownForm.addEventListener("submit", generateTaskDrafts);
breakdownSaveForm.addEventListener("submit", saveTaskDrafts);
breakdownGoal.addEventListener("input", () => {
  updateBreakdownControls();
  if (draftGoal !== null) {
    setBreakdownStatus(breakdownSave.disabled ? "目标已修改，请重新生成子任务。" : "可以继续编辑或保存草稿。");
  }
});

/* ---------- AI 聊天 ---------- */
const chatDialog = document.getElementById("chat-dialog");
const chatHeading = document.getElementById("chat-heading");
const chatNote = document.getElementById("chat-note");
const chatEmpty = document.getElementById("chat-empty");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatReset = document.getElementById("chat-reset");
const chatThreads = new Map();
const chatHistoryLimit = 16;
let activeChat = null;

function chatMessage(role, content) {
  const item = document.createElement("li");
  item.className = `chat-message chat-${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "你" : "AI";
  const text = document.createElement("p");
  text.textContent = content;
  item.append(label, text);
  return item;
}

function renderChat(thread) {
  const messages = thread.messages.slice();
  if (thread.pending) messages.push({ role: "user", content: thread.draft });
  chatLog.replaceChildren(...messages.map(({ role, content }) => chatMessage(role, content)));
  chatLog.hidden = !messages.length;
  chatEmpty.hidden = !!messages.length;
  chatLog.scrollTop = chatLog.scrollHeight;
  chatInput.value = thread.pending ? "" : thread.draft;
  chatInput.readOnly = thread.pending;
  chatSend.disabled = thread.pending;
  chatReset.disabled = thread.pending || (!thread.messages.length && !thread.draft);
  chatSend.textContent = thread.pending ? "等待回复…" : "发送";
  const status = document.getElementById("chat-status");
  status.textContent = thread.pending ? "AI 正在回复…" : thread.error;
  status.classList.toggle("is-error", !!thread.error);
}

function openChat(task = null) {
  const taskId = task?.id ?? null;
  if (!chatThreads.has(taskId)) {
    chatThreads.set(taskId, { taskId, messages: [], draft: "", pending: false, error: "" });
  }
  activeChat = chatThreads.get(taskId);
  chatHeading.textContent = task ? `聊这个计划：${task.title}` : "AI 聊天";
  chatNote.textContent = task
    ? "发送时会把近期对话和此计划的标题、描述及完成状态发给模型；不会更改任务。"
    : "发送时只把近期对话发给配置的模型，不会自动读取任务。";
  chatEmpty.textContent = task
    ? "可以问：从哪里开始？有什么风险？怎样判断做到位了？"
    : "随便聊聊，或说说你正在考虑的安排。";
  renderChat(activeChat);
  chatDialog.showModal();
  chatLog.scrollTop = chatLog.scrollHeight;
  chatInput.focus();
}

chatInput.addEventListener("input", () => {
  activeChat.draft = chatInput.value;
  chatReset.disabled = !activeChat.messages.length && !activeChat.draft;
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
    const { reply } = await request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: thread.taskId, messages: [...thread.messages, userMessage] }),
    });
    if (typeof reply !== "string" || !reply.trim()) throw new Error("没有收到有效回复，请重试。");
    thread.messages = [...thread.messages, userMessage, { role: "assistant", content: reply }]
      .slice(-chatHistoryLimit);
    thread.draft = "";
  } catch (err) {
    thread.error = err.message;
  } finally {
    thread.pending = false;
    if (chatDialog.open && activeChat === thread) {
      renderChat(thread);
      if (document.activeElement === chatDialog || document.activeElement === document.body) chatInput.focus();
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
});
document.getElementById("chat-open").addEventListener("click", () => openChat());
document.getElementById("chat-close").addEventListener("click", () => chatDialog.close());

/* ---------- 数据加载 ---------- */
async function changeFilter(filter) {
  currentFilter = filter;
  filterButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.filter === filter));
  await loadTasks();
}
let taskLoadVersion = 0;

async function loadTasks() {
  const version = ++taskLoadVersion;
  try {
    const tasks = await request(`${API_URL}?status=${currentFilter}`);
    if (version === taskLoadVersion) renderTasks(tasks);
  } catch (err) {
    if (version !== taskLoadVersion) return;
    showToast("加载任务失败：" + err.message, "error");
    renderTasks([]);
  }
}

function renderTasks(tasks) {
  taskList.innerHTML = "";
  tasks.forEach((task) => taskList.appendChild(buildTaskItem(task)));

  emptyState.style.display = tasks.length ? "none" : "block";
  emptyState.textContent =
    currentFilter === "completed"
      ? "还没有已完成的任务。"
      : currentFilter === "active"
      ? "没有进行中的任务 — 干得漂亮！"
      : "还没有任务，先在上方添加一个吧 🎉";

  updateCount(tasks);
}

function buildTaskItem(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.completed ? " is-completed" : "");
  li.dataset.id = task.id;
  li.id = `task-${task.id}`;
  li.tabIndex = -1;

  li.innerHTML = `
    <input type="checkbox" class="task-check" ${task.completed ? "checked" : ""} />
    <div class="task-body">
      <div class="task-title">${escapeHtml(task.title)}</div>
      ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ""}
      <div class="task-meta">创建于 ${formatDate(task.created_at)}</div>
    </div>
    <div class="task-actions">
      <button type="button" class="icon-btn task-chat-btn" title="围绕此任务聊天">聊计划</button>
      <button class="icon-btn edit-btn" title="编辑">✏️</button>
      <button class="icon-btn danger delete-btn" title="删除">🗑️</button>
    </div>
  `;

  li.querySelector(".task-chat-btn").addEventListener("click", () => openChat(task));
  li.querySelector(".task-check").addEventListener("change", () => toggleTask(task.id));
  li.querySelector(".edit-btn").addEventListener("click", () => openEditModal(task));
  li.querySelector(".delete-btn").addEventListener("click", () => deleteTask(task.id));
  return li;
}

async function updateCount(tasks) {
  // 处于筛选状态时，额外获取全部任务用于计算“已完成 X / 共 Y”。
  let all = tasks;
  if (currentFilter !== "all") {
    try {
      all = await request(`${API_URL}?status=all`);
    } catch (e) {
      all = tasks;
    }
  }
  const total = all.length;
  const done = all.filter((t) => t.completed).length;
  taskCount.textContent = total ? `已完成 ${done} / 共 ${total}` : "";
}

/* ---------- 操作 ---------- */
async function addTask(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const description = descInput.value.trim();
  if (!title) {
    showToast("请输入任务标题", "error");
    return;
  }
  try {
    await request(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    titleInput.value = "";
    descInput.value = "";
    showToast("任务已添加", "success");
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function toggleTask(id) {
  try {
    await request(`${API_URL}/${id}/toggle`, { method: "PATCH" });
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
    loadTasks();
  }
}

async function deleteTask(id) {
  if (!confirm("确定要删除这个任务吗？")) return;
  try {
    await request(`${API_URL}/${id}`, { method: "DELETE" });
    if (activeChat?.taskId === id) {
      chatDialog.close();
      activeChat = null;
    }
    chatThreads.delete(id);
    showToast("任务已删除", "success");
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function openEditModal(task) {
  editingId = task.id;
  editTitle.value = task.title;
  editDesc.value = task.description || "";
  editModal.classList.remove("is-hidden");
  editTitle.focus();
}

function closeEditModal() {
  editingId = null;
  editModal.classList.add("is-hidden");
}

async function saveEdit() {
  const title = editTitle.value.trim();
  if (!title) {
    showToast("标题不能为空", "error");
    return;
  }
  try {
    await request(`${API_URL}/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: editDesc.value.trim() }),
    });
    showToast("任务已更新", "success");
    closeEditModal();
    loadTasks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ---------- 事件绑定 ---------- */
taskForm.addEventListener("submit", addTask);
recommendForm.addEventListener("submit", generateRecommendations);

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => changeFilter(btn.dataset.filter));
});

editSave.addEventListener("click", saveEdit);
editCancel.addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !editModal.classList.contains("is-hidden")) closeEditModal();
});

// 首次加载
loadTasks();
