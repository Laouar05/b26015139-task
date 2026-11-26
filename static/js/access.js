/* Same-origin session, permissions and administration. */
const access = (id) => document.getElementById(id);
const authState = { user: null, roles: [], permissions: new Set(), csrf: null, epoch: 0 };
const pendingRequests = new Set();
let identityRefresh;
let csrfRequest;
let registrationEnabled = false;
const authDialog = access('auth-dialog');
const adminDialog = access('admin-dialog');
const transferDialog = access('transfer-dialog');
const roleNames = { admin: '管理员', member: '普通成员', viewer: '只读访客' };
const permissionNames = {
  'task:read': '查看本人任务',
  'task:write': '编辑/新增/删除本人任务',
  'task:read_all': '查看全库任务',
  'task:write_all': '修改/删除他人任务',
  'task:assign': '转交任务归属',
  'ai:chat': 'AI 对话助手',
  'ai:recommend': 'AI 今日建议',
  'ai:decompose': 'AI 任务拆解',
  'user:manage': '用户管理',
  'role:manage': '角色与权限管理',
};
function createRolePill(code) {
  const pill = document.createElement('span');
  pill.className = `role-pill${['admin', 'member', 'viewer'].includes(code) ? ` is-${code}` : ''}`;
  pill.textContent = roleNames[code] || code;
  return pill;
}
const hasPermissions = (...codes) => Boolean(authState.user) && codes.every((code) => authState.permissions.has(code));
const mayWriteTask = (task) => hasPermissions('task:read', 'task:write') &&
  (task.owner_id === authState.user.id || hasPermissions('task:read_all', 'task:write_all'));
const canUseTab = (tab) => tab === 'recommend' ? hasPermissions('task:read', 'ai:recommend') : hasPermissions('ai:decompose');
const jsonOptions = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const abortError = () => new DOMException('请求已取消', 'AbortError');

class RequestError extends Error {
  constructor(status, body) {
    super(body.error || `请求失败（${status}）`);
    this.status = status;
    this.code = body.code;
  }
}

function getCsrf() {
  if (!csrfRequest) {
    const current = request('/api/auth/csrf').then((data) => {
      authState.csrf = data.csrf_token;
      registrationEnabled = data.registration_enabled;
      access('auth-switch').hidden = !registrationEnabled;
      return authState.csrf;
    });
    csrfRequest = current;
    const release = () => { if (csrfRequest === current) csrfRequest = null; };
    current.then(release, release);
  }
  return csrfRequest;
}

async function request(url, options = {}) {
  const epoch = authState.epoch;
  const controller = new AbortController();
  pendingRequests.add(controller);
  try {
    const headers = new Headers(options.headers);
    if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) {
      headers.set('X-CSRF-Token', authState.csrf || await getCsrf());
    }
    if (epoch !== authState.epoch) throw abortError();
    const response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: 'same-origin' });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (epoch !== authState.epoch) throw abortError();
    if (response.ok) return data;
    const error = new RequestError(response.status, data || {});
    if (error.code === 'AUTH_REQUIRED') {
      if (authState.user) applyIdentity(null);
      if (url !== '/api/auth/me') {
        openAuth();
        throw abortError();
      }
    } else if (error.code === 'PERMISSION_DENIED') {
      showToast('没有执行此操作的权限。', 'error');
      refreshIdentity();
    } else if (error.code === 'CSRF_INVALID') {
      authState.csrf = null;
      getCsrf().catch(() => {});
    } else if (error.code === 'TASK_NOT_FOUND') {
      showToast('任务不可用，正在刷新列表。', 'error');
      loadTasks();
    }
    throw error;
  } finally {
    pendingRequests.delete(controller);
  }
}

function clearPrivateData() {
  ++authState.epoch;
  csrfRequest = null;
  for (const controller of pendingRequests) controller.abort();
  ++taskLoadVersion;
  allTasks = [];
  searchQuery = searchInput.value = '';
  taskForm.reset();
  titleCounter.textContent = '0 / 200';
  titleCounter.classList.remove('is-warn');
  collapseComposer(true);
  closeEditModal();
  editForm.reset();
  closeDeleteConfirm();
  confirmDesc.textContent = '删除后无法恢复。';
  recommendForm.reset();
  recommendResults.replaceChildren();
  recommendStatus.textContent = '';
  setButtonLoading(recommendSubmit, false, '正在分析排期…', '生成行动建议');
  breakdownForm.reset();
  breakdownResults.replaceChildren();
  draftGoal = null;
  breakdownBusy = false;
  setButtonLoading(breakdownGenerate, false, '正在拆解目标…', '生成子任务草稿');
  setButtonLoading(breakdownSave, false, '正在加入列表…', '批量加入任务列表');
  setBreakdownStatus('');
  updateBreakdownControls();
  closeChatDrawer();
  activeChat = null;
  chatThreads.clear();
  chatForm.reset();
  chatLog.replaceChildren();
  chatStatus.textContent = chatContextTitle.textContent = chatContextDesc.textContent = '';
  if (adminDialog.open) adminDialog.close();
  if (transferDialog.open) transferDialog.close();
  access('admin-list').replaceChildren();
  access('admin-role-options').replaceChildren();
  access('admin-roles').replaceChildren();
  access('admin-target').textContent = '';
  access('admin-edit').hidden = true;
  access('admin-search').reset();
  access('transfer-search').reset();
  access('transfer-user').replaceChildren();
  access('transfer-task-name').textContent = '';
  adminTarget = transferTask = null;
  roleCatalog = [];
  const aiChip = access('ai-active-chip');
  if (aiChip) { aiChip.hidden = true; aiChip.textContent = ''; }
  updateProgressAndBadges();
  changeFilter('all');
}

function renderPermissions() {
  document.body.removeAttribute('data-auth-pending');
  const signedIn = Boolean(authState.user);
  const read = hasPermissions('task:read');
  const write = hasPermissions('task:write');
  const chat = hasPermissions('ai:chat');
  const recommend = canUseTab('recommend');
  const decompose = canUseTab('breakdown');
  access('account-avatar').textContent = signedIn ? authState.user.username.slice(0, 1).toUpperCase() : '?';
  access('account-state').textContent = signedIn ? authState.user.username : '登录后查看任务';
  const badgeBox = access('account-role-badges');
  if (signedIn) {
    const pills = authState.roles.map(createRolePill);
    if (read && !write) {
      const note = document.createElement('span');
      note.className = 'role-pill is-readonly-note';
      note.textContent = '仅能查看，不可修改';
      pills.push(note);
    }
    badgeBox.replaceChildren(...pills);
  } else {
    badgeBox.replaceChildren();
  }
  access('auth-open').hidden = signedIn;
  access('auth-logout').hidden = !signedIn;
  access('admin-open').hidden = !hasPermissions('role:manage') && !hasPermissions('user:manage');
  access('chat-open').hidden = access('mobile-chat-btn').hidden = !chat;
  document.querySelector('.tasks-section').hidden = !read;
  document.querySelector('.header-tools').hidden = !read;
  document.querySelector('.mobile-filters').hidden = !read;
  document.querySelector('.sidebar').hidden = !read;
  composerCard.hidden = !write;
  breakdownSave.hidden = !write;
  access('recommend-scope-wrap').hidden = !hasPermissions('task:read_all');
  access('ai-studio').hidden = !recommend && !decompose;
  document.querySelector('.studio-shell').classList.toggle('without-ai', !recommend && !decompose);
  aiTabs.forEach((tab) => { tab.hidden = !canUseTab(tab.dataset.aiTab); });
  aiShortcuts.forEach((item) => { item.hidden = !canUseTab(item.dataset.aiJump); });
  if (recommend || decompose) switchAiTab(recommend ? 'recommend' : 'breakdown');
  renderTaskList();
}

function applyIdentity(data) {
  const permissions = new Set(data?.permissions || []);
  const nextUser = data?.user || null;
  const changed = authState.user?.id !== nextUser?.id || permissions.size !== authState.permissions.size ||
    [...permissions].some((code) => !authState.permissions.has(code));
  authState.user = nextUser;
  authState.roles = data?.roles || [];
  authState.permissions = permissions;
  if (changed) {
    authState.csrf = data?.csrf_token || null;
    clearPrivateData();
  }
  if (data?.csrf_token) authState.csrf = data.csrf_token;
  renderPermissions();
  if (changed && hasPermissions('task:read')) loadTasks();
  if (changed && authState.user && (hasPermissions('ai:chat') || canUseTab('recommend') || canUseTab('breakdown'))) {
    loadActiveAiChip();
  }
}

function refreshIdentity() {
  if (!identityRefresh) {
    identityRefresh = request('/api/auth/me').then(applyIdentity).catch((error) => {
      if (error.code === 'AUTH_REQUIRED') {
        applyIdentity(null);
        openAuth();
      } else if (error.name !== 'AbortError') {
        if (!authState.user) renderPermissions();
        showToast(error.message, 'error');
      }
    }).finally(() => { identityRefresh = null; });
  }
  return identityRefresh;
}

let authMode = 'login';
function resetPasswordVisibility() {
  const pw = access('auth-password');
  const btn = access('auth-toggle-pw');
  pw.type = 'password';
  if (btn) {
    btn.classList.remove('is-visible');
    btn.setAttribute('aria-label', '显示密码');
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  access('auth-heading').textContent = registering ? '注册澄序账号' : '登录澄序';
  access('auth-subtitle').textContent = registering ? '创建普通成员账号，开启高效任务管理' : '进入你的智能任务工作台';
  access('auth-submit').textContent = registering ? '注册' : '登录';
  access('auth-switch').textContent = registering ? '已有账号？返回登录' : '没有账号？去注册';
  access('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  access('auth-password').value = '';
  resetPasswordVisibility();
  access('auth-feedback').textContent = '';
}

function openAuth() {
  if (authDialog.open) return;
  setAuthMode('login');
  authDialog.showModal();
  getCsrf().catch((error) => {
    if (error.name !== 'AbortError') access('auth-feedback').textContent = error.message;
  });
}

document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
[adminDialog, transferDialog].forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});
access('auth-toggle-pw')?.addEventListener('click', () => {
  const pw = access('auth-password');
  const btn = access('auth-toggle-pw');
  const showing = pw.type === 'text';
  pw.type = showing ? 'password' : 'text';
  btn.classList.toggle('is-visible', !showing);
  btn.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
  pw.focus();
});
authDialog.addEventListener('close', () => {
  access('auth-password').value = '';
  resetPasswordVisibility();
});
access('auth-open').addEventListener('click', openAuth);
access('auth-switch').addEventListener('click', () => {
  if (registrationEnabled) setAuthMode(authMode === 'login' ? 'register' : 'login');
});
access('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = access('auth-feedback');
  const submit = access('auth-submit');
  const mode = authMode;
  const payload = { username: access('auth-username').value, password: access('auth-password').value };
  submit.disabled = access('auth-switch').disabled = true;
  feedback.textContent = '';
  try {
    const data = await request(`/api/auth/${mode}`, jsonOptions('POST', payload));
    if (mode === 'register') {
      setAuthMode('login');
      access('auth-username').value = data.username;
      feedback.textContent = '注册成功，请登录。';
      access('auth-password').focus();
    } else {
      applyIdentity(data);
      access('auth-form').reset();
      authDialog.close();
      access('auth-logout').focus();
    }
  } catch (error) {
    if (error.name !== 'AbortError') feedback.textContent = error.message;
  } finally {
    access('auth-password').value = '';
    submit.disabled = access('auth-switch').disabled = false;
  }
});
access('auth-logout').addEventListener('click', async () => {
  const button = access('auth-logout');
  button.disabled = true;
  try {
    await request('/api/auth/logout', { method: 'POST' });
    applyIdentity(null);
    openAuth();
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

let roleCatalog = [];
let adminTarget = null;
let adminPage = 1;
let adminListVersion = 0;
let adminDetailVersion = 0;
let transferTask = null;
let transferSearchVersion = 0;
const adminFeedback = (message) => { access('admin-feedback').textContent = message; };
const transferFeedback = (message) => { access('transfer-feedback').textContent = message; };

function showRoleCatalog(roles) {
  roleCatalog = roles;
  access('admin-roles').replaceChildren(...roles.map((role) => {
    const box = document.createElement('details');
    box.className = 'role-catalog-card';
    const heading = document.createElement('summary');
    const left = document.createElement('span');
    left.className = 'role-summary-left';
    left.append(createRolePill(role.code));
    const count = document.createElement('span');
    count.className = 'role-summary-count';
    count.textContent = `${role.permissions.length} 项权限`;
    heading.append(left, count);

    const body = document.createElement('div');
    body.className = 'role-catalog-body';
    const description = document.createElement('p');
    description.className = 'role-catalog-desc';
    description.textContent = role.description;
    const tags = document.createElement('div');
    tags.className = 'perm-tag-list';
    tags.append(...role.permissions.map((code) => {
      const tag = document.createElement('span');
      tag.className = 'perm-tag';
      tag.textContent = permissionNames[code] || code;
      tag.title = code;
      return tag;
    }));
    body.append(description, tags);
    box.append(heading, body);
    return box;
  }));
}

function syncAdminListSelection() {
  access('admin-list').querySelectorAll('.admin-user-btn').forEach((btn) => {
    btn.classList.toggle('is-selected', Number(btn.dataset.userId) === adminTarget?.id);
  });
}

async function selectAdminUser(id) {
  const version = ++adminDetailVersion;
  adminFeedback('');
  try {
    const user = await request(`/api/admin/users/${id}`);
    if (!adminDialog.open || version !== adminDetailVersion) return;
    adminTarget = user;
    syncAdminListSelection();
    const own = id === authState.user.id;
    access('admin-edit').hidden = false;
    access('admin-target').textContent = `${user.username}${own ? '（本人）' : ''}`;
    access('admin-role-fields').hidden = !hasPermissions('role:manage');
    access('admin-role-fields').disabled = own;
    access('admin-role-options').replaceChildren(...roleCatalog.map((role) => {
      const label = document.createElement('label');
      label.className = 'role-option-card';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = role.code;
      check.checked = user.roles.includes(role.code);
      const name = document.createElement('span');
      name.textContent = role.name;
      label.append(check, name);
      return label;
    }));
    const toggle = access('admin-toggle-active');
    toggle.textContent = user.is_active ? '禁用账号' : '启用账号';
    toggle.disabled = own;
  } catch (error) {
    if (error.name !== 'AbortError' && version === adminDetailVersion) adminFeedback(error.message);
  }
}

async function loadAdminUsers(page = 1) {
  const version = ++adminListVersion;
  try {
    const query = new URLSearchParams({ page, limit: 20, q: access('admin-query').value.trim() });
    const { items, total, limit } = await request(`/api/admin/users?${query}`);
    if (!adminDialog.open || version !== adminListVersion) return;
    adminPage = page;
    access('admin-page').textContent = `第 ${page} 页 · 共 ${total} 人`;
    access('admin-prev').disabled = page <= 1;
    access('admin-next').disabled = page * limit >= total;
    access('admin-list').replaceChildren(...items.map((user) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `admin-user-btn${adminTarget?.id === user.id ? ' is-selected' : ''}`;
      button.dataset.userId = String(user.id);

      const main = document.createElement('span');
      main.className = 'admin-user-main';
      const avatar = document.createElement('span');
      avatar.className = 'admin-user-avatar';
      avatar.textContent = user.username.slice(0, 1).toUpperCase();
      const info = document.createElement('span');
      info.className = 'admin-user-info';
      const name = document.createElement('span');
      name.className = 'admin-user-name';
      name.textContent = user.username;
      const roles = document.createElement('span');
      roles.className = 'admin-user-roles';
      roles.append(...user.roles.map(createRolePill));
      info.append(name, roles);
      main.append(avatar, info);

      const status = document.createElement('span');
      status.className = `user-status-badge${user.is_active ? '' : ' is-disabled'}`;
      status.textContent = user.is_active ? '有效' : '已禁用';

      button.append(main, status);
      button.addEventListener('click', () => selectAdminUser(user.id));
      item.append(button);
      return item;
    }));
  } catch (error) {
    if (error.name !== 'AbortError' && version === adminListVersion) adminFeedback(error.message);
  }
}

access('admin-open').addEventListener('click', async () => {
  adminTarget = null;
  access('admin-edit').hidden = true;
  access('admin-users').hidden = !hasPermissions('user:manage');
  access('admin-role-catalog').hidden = !hasPermissions('role:manage');
  access('admin-list').replaceChildren();
  access('admin-roles').replaceChildren();
  adminFeedback('');
  access('admin-tab-providers').hidden = !hasPermissions('role:manage');
  switchAdminTab('users');
  adminDialog.showModal();
  if (hasPermissions('role:manage')) {
    try {
      const { roles } = await request('/api/admin/roles');
      if (adminDialog.open) showRoleCatalog(roles);
    } catch (error) {
      if (error.name !== 'AbortError') adminFeedback(error.message);
    }
  }
  if (hasPermissions('user:manage') && adminDialog.open) loadAdminUsers();
});
access('admin-search').addEventListener('submit', (event) => { event.preventDefault(); loadAdminUsers(); });
access('admin-prev').addEventListener('click', () => loadAdminUsers(adminPage - 1));
access('admin-next').addEventListener('click', () => loadAdminUsers(adminPage + 1));

async function saveAdminUser(path, options, button, id) {
  button.disabled = true;
  let notice = '';
  try {
    await request(path, options);
    notice = '已更新账号。';
    if (adminTarget?.id === id && adminDialog.open) await selectAdminUser(id);
    await loadAdminUsers(adminPage);
  } catch (error) {
    if (error.name === 'AbortError') return;
    notice = error.message;
    if (error.status === 409 && adminTarget?.id === id) await selectAdminUser(id);
  } finally {
    button.disabled = adminTarget?.id === authState.user?.id;
  }
  if (adminDialog.open) adminFeedback(notice);
}

access('admin-edit').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = adminTarget;
  if (!target || target.id === authState.user.id) return;
  const roles = [...access('admin-role-options').querySelectorAll(':checked')].map((input) => input.value);
  if (!roles.length) { adminFeedback('请至少选择一个角色。'); return; }
  if (!window.confirm(`将 ${target.username} 的全部角色替换为「${roles.map((role) => roleNames[role] || role).join('、')}」？`)) return;
  saveAdminUser(`/api/admin/users/${target.id}/roles`, jsonOptions('PUT', { roles }), access('admin-save-roles'), target.id);
});
access('admin-toggle-active').addEventListener('click', (event) => {
  const target = adminTarget;
  if (!target || target.id === authState.user.id) return;
  if (!window.confirm(`${target.is_active ? '禁用' : '启用'} ${target.username}？`)) return;
  saveAdminUser(`/api/admin/users/${target.id}`, jsonOptions('PATCH', { is_active: !target.is_active }), event.currentTarget, target.id);
});

function openTransfer(task) {
  transferTask = task;
  access('transfer-search').reset();
  access('transfer-task-name').textContent = task.title;
  transferDialog.showModal();
  loadTransferUsers();
}

async function loadTransferUsers() {
  const version = ++transferSearchVersion;
  const select = access('transfer-user');
  select.replaceChildren();
  access('transfer-submit').disabled = true;
  transferFeedback('正在查找用户…');
  try {
    const query = new URLSearchParams({ limit: 50, q: access('transfer-query').value.trim() });
    const { items } = await request(`/api/admin/users?${query}`);
    if (!transferDialog.open || version !== transferSearchVersion) return;
    const users = items.filter((user) => user.is_active && user.id !== transferTask.owner_id);
    select.replaceChildren(new Option('请选择', ''), ...users.map((user) => new Option(user.username, String(user.id))));
    transferFeedback(users.length ? '转交后，原归属人不再拥有此任务。' : '未找到可转交的用户，请换个关键词。');
  } catch (error) {
    if (error.name !== 'AbortError' && version === transferSearchVersion) transferFeedback(error.message);
  }
}

access('transfer-search').addEventListener('submit', (event) => { event.preventDefault(); loadTransferUsers(); });
access('transfer-user').addEventListener('change', () => { access('transfer-submit').disabled = !access('transfer-user').value; });
access('transfer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = access('transfer-user');
  const task = transferTask;
  if (!task || !target.value || !window.confirm(`确认把任务转交给 ${target.selectedOptions[0].textContent}？`)) return;
  const button = access('transfer-submit');
  button.disabled = true;
  try {
    await request(`/api/admin/tasks/${task.id}/owner`, jsonOptions('PUT', { owner_id: Number(target.value) }));
    if (transferTask === task) transferDialog.close();
    showToast('任务已转交。', 'success');
    await loadTasks();
  } catch (error) {
    if (error.name !== 'AbortError') transferFeedback(error.message);
  } finally {
    button.disabled = !target.value;
  }
});

/* ---------- Active AI Chip & Admin AI Providers ---------- */
const PROVIDER_PRESETS = {
  deepseek: { name: 'DeepSeek', provider_type: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  gemini: { name: 'Google Gemini', provider_type: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  openai: { name: 'OpenAI', provider_type: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  siliconflow: { name: '硅基流动', provider_type: 'openai', base_url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  qwen: { name: '通义千问', provider_type: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { name: '本地 Ollama', provider_type: 'openai', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  custom: { name: '', provider_type: 'openai', base_url: '', model: '' },
};
const providerTypeLabels = { openai: 'OpenAI 兼容', gemini: 'Gemini 原生' };
let editingProviderId = null;
let providerListVersion = 0;

async function loadActiveAiChip() {
  const chip = access('ai-active-chip');
  if (!chip || !authState.user) return;
  try {
    const info = await request('/api/ai/active');
    if (!authState.user) return;
    chip.hidden = false;
    if (info.configured) {
      chip.classList.remove('is-empty');
      chip.textContent = `${info.name} · ${info.model}`;
      chip.title = `当前启用模型：${info.name}（${info.model}）`;
    } else {
      chip.classList.add('is-empty');
      chip.textContent = '未配置模型';
      chip.title = '管理员可在「管理 → AI 提供商」中添加并启用模型';
    }
  } catch (error) {
    if (error.name !== 'AbortError') chip.hidden = true;
  }
}

function switchAdminTab(tabName) {
  const isProviders = tabName === 'providers' && hasPermissions('role:manage');
  document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
    const active = tab.dataset.adminTab === (isProviders ? 'providers' : 'users');
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  access('admin-pane-users').hidden = isProviders;
  access('admin-pane-providers').hidden = !isProviders;
  adminFeedback('');
  if (isProviders) {
    resetProviderForm();
    loadAiProviders();
  }
}

document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
  tab.addEventListener('click', () => switchAdminTab(tab.dataset.adminTab));
});

function resetProviderForm() {
  editingProviderId = null;
  access('provider-form').reset();
  access('provider-type').value = 'openai';
  access('provider-activate').checked = true;
  access('provider-key').placeholder = '填写 API Key（本机 Ollama 可留空）';
  access('provider-form-title').textContent = '添加 AI 提供商';
  access('provider-save').textContent = '保存提供商';
  access('provider-cancel-edit').hidden = true;
  const select = access('provider-model-select');
  select.hidden = true;
  select.replaceChildren();
}

function startEditProvider(provider) {
  editingProviderId = provider.id;
  access('provider-name').value = provider.name;
  access('provider-type').value = provider.provider_type;
  access('provider-url').value = provider.base_url;
  access('provider-key').value = '';
  access('provider-key').placeholder = provider.has_api_key
    ? `已保存密钥（${provider.api_key_preview}），留空保持不变`
    : '当前无密钥，如需填写请输入';
  access('provider-model').value = provider.model;
  access('provider-activate').checked = Boolean(provider.is_active);
  access('provider-form-title').textContent = `编辑提供商：${provider.name}`;
  access('provider-save').textContent = '保存修改';
  access('provider-cancel-edit').hidden = false;
  const select = access('provider-model-select');
  select.hidden = true;
  select.replaceChildren();
  access('provider-name').focus();
}

async function loadAiProviders() {
  const version = ++providerListVersion;
  try {
    const { items, env_fallback: envFallback } = await request('/api/admin/ai-providers');
    if (!adminDialog.open || version !== providerListVersion) return;

    const banner = access('provider-active-banner');
    const active = items.find((item) => item.is_active);
    if (active) {
      banner.classList.remove('is-empty');
      banner.textContent = `当前启用：${active.name}（${providerTypeLabels[active.provider_type] || active.provider_type} · ${active.model}）`;
    } else if (envFallback?.configured) {
      banner.classList.remove('is-empty');
      banner.textContent = `当前回退使用默认环境配置：${envFallback.model}`;
    } else {
      banner.classList.add('is-empty');
      banner.textContent = '尚未启用任何 AI 提供商，请先在下方添加并启用。';
    }

    const list = access('provider-list');
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'provider-empty';
      empty.textContent = '还没有手动添加的 AI 提供商，点下方预设可一键填入常用配置。';
      list.replaceChildren(empty);
      return;
    }

    list.replaceChildren(...items.map((provider) => {
      const li = document.createElement('li');
      li.className = `provider-card${provider.is_active ? ' is-active' : ''}`;

      const top = document.createElement('div');
      top.className = 'provider-card-top';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'provider-card-title-wrap';
      const name = document.createElement('span');
      name.className = 'provider-card-name';
      name.textContent = provider.name;
      const typePill = document.createElement('span');
      typePill.className = `role-pill ${provider.provider_type === 'gemini' ? 'is-admin' : 'is-member'}`;
      typePill.textContent = providerTypeLabels[provider.provider_type] || provider.provider_type;
      titleWrap.append(name, typePill);

      const status = document.createElement('span');
      if (provider.is_active) {
        status.className = 'user-status-badge';
        status.textContent = '当前启用';
      } else {
        status.className = 'role-pill is-viewer';
        status.textContent = '备用';
      }
      top.append(titleWrap, status);

      const meta = document.createElement('div');
      meta.className = 'provider-meta';
      const mLine = document.createElement('div');
      mLine.innerHTML = `模型：<strong>${escapeHtml(provider.model)}</strong>`;
      const uLine = document.createElement('div');
      uLine.textContent = `地址：${provider.base_url}`;
      const kLine = document.createElement('div');
      kLine.textContent = `密钥：${provider.has_api_key ? provider.api_key_preview : '未设置（本地免密钥）'}`;
      meta.append(mLine, uLine, kLine);

      const actions = document.createElement('div');
      actions.className = 'provider-card-actions';

      if (!provider.is_active) {
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'btn btn-ink btn-sm';
        useBtn.textContent = '切换使用';
        useBtn.addEventListener('click', () => activateProvider(provider, useBtn));
        actions.append(useBtn);
      }

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-subtle btn-sm';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => startEditProvider(provider));
      actions.append(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-text btn-sm btn-danger-text';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteProvider(provider, delBtn));
      actions.append(delBtn);

      li.append(top, meta, actions);
      return li;
    }));
  } catch (error) {
    if (error.name !== 'AbortError' && version === providerListVersion) adminFeedback(error.message);
  }
}

async function activateProvider(provider, button) {
  button.disabled = true;
  adminFeedback('');
  try {
    await request(`/api/admin/ai-providers/${provider.id}/activate`, { method: 'POST' });
    showToast(`已切换 AI 提供商为「${provider.name}」`, 'success');
    await Promise.all([loadAiProviders(), loadActiveAiChip()]);
  } catch (error) {
    if (error.name !== 'AbortError') adminFeedback(error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteProvider(provider, button) {
  if (!window.confirm(`确定删除 AI 提供商「${provider.name}」吗？`)) return;
  button.disabled = true;
  adminFeedback('');
  try {
    await request(`/api/admin/ai-providers/${provider.id}`, { method: 'DELETE' });
    if (editingProviderId === provider.id) resetProviderForm();
    showToast(`已删除「${provider.name}」`, 'success');
    await Promise.all([loadAiProviders(), loadActiveAiChip()]);
  } catch (error) {
    if (error.name !== 'AbortError') adminFeedback(error.message);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('[data-provider-preset]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const preset = PROVIDER_PRESETS[chip.dataset.providerPreset];
    if (!preset) return;
    if (editingProviderId !== null) resetProviderForm();
    access('provider-name').value = preset.name;
    access('provider-type').value = preset.provider_type;
    access('provider-url').value = preset.base_url;
    access('provider-model').value = preset.model;
    access('provider-key').focus();
  });
});

access('provider-new-btn')?.addEventListener('click', () => {
  resetProviderForm();
  access('provider-name').focus();
});

access('provider-cancel-edit')?.addEventListener('click', () => {
  resetProviderForm();
  adminFeedback('');
});

access('provider-model-select')?.addEventListener('change', (event) => {
  if (event.target.value) access('provider-model').value = event.target.value;
});

access('provider-fetch-models')?.addEventListener('click', async () => {
  const btn = access('provider-fetch-models');
  const select = access('provider-model-select');
  const baseUrl = access('provider-url').value.trim();
  const providerType = access('provider-type').value;
  const apiKey = access('provider-key').value.trim();
  if (!baseUrl) {
    adminFeedback('请先填写 API 基础地址再拉取模型列表。');
    access('provider-url').focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = '拉取中…';
  adminFeedback('');
  try {
    const payload = { provider_type: providerType, base_url: baseUrl, api_key: apiKey };
    if (!apiKey && editingProviderId !== null) payload.provider_id = editingProviderId;
    const { models } = await request('/api/admin/ai-providers/models', jsonOptions('POST', payload));
    select.replaceChildren(
      new Option(`已拉取 ${models.length} 个模型，点击选择…`, ''),
      ...models.map((id) => new Option(id, id))
    );
    select.hidden = false;
    if (!access('provider-model').value.trim() && models.length) {
      access('provider-model').value = models[0];
      select.value = models[0];
    }
    adminFeedback(`成功拉取 ${models.length} 个可用模型。`);
  } catch (error) {
    if (error.name !== 'AbortError') adminFeedback(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型';
  }
});

access('provider-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saveBtn = access('provider-save');
  const isEdit = editingProviderId !== null;
  const payload = {
    name: access('provider-name').value.trim(),
    provider_type: access('provider-type').value,
    base_url: access('provider-url').value.trim(),
    model: access('provider-model').value.trim(),
    activate: access('provider-activate').checked,
  };
  const keyVal = access('provider-key').value.trim();
  if (keyVal || !isEdit) payload.api_key = keyVal;

  saveBtn.disabled = true;
  adminFeedback('');
  try {
    const path = isEdit ? `/api/admin/ai-providers/${editingProviderId}` : '/api/admin/ai-providers';
    await request(path, jsonOptions(isEdit ? 'PUT' : 'POST', payload));
    showToast(isEdit ? 'AI 提供商已更新' : 'AI 提供商已添加', 'success');
    resetProviderForm();
    await Promise.all([loadAiProviders(), loadActiveAiChip()]);
  } catch (error) {
    if (error.name !== 'AbortError') adminFeedback(error.message);
  } finally {
    saveBtn.disabled = false;
  }
});

refreshIdentity();
