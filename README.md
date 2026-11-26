# 任务管理器（Python 全栈示例）

一个包含**前端 + 后端 + 数据库**的小型项目，基于 **Flask**、**SQLite** 与原生
**HTML/CSS/JavaScript** 构建，演示了一个完整的增删改查（CRUD）应用。

## 功能特性

- ➕ 添加任务（标题 + 可选描述）
- ✅ 切换完成状态
- ✏️ 编辑 / 🗑️ 删除任务
- 🔍 按 全部 / 进行中 / 已完成 筛选
- 💾 通过 SQLAlchemy 将数据持久化到 SQLite 数据库
- 🎨 简洁的深色响应式界面

## 技术栈

| 层级   | 技术                              |
|--------|-----------------------------------|
| 后端   | Flask（REST API）                 |
| 数据库 | SQLite + Flask-SQLAlchemy（ORM）  |
| 前端   | HTML、CSS、原生 JavaScript        |

## 项目结构

```
task/
├── app.py              # Flask 应用工厂 + REST API 路由
├── models.py           # SQLAlchemy 的 Task 数据模型
├── config.py           # 配置（数据库 URI、密钥）
├── requirements.txt    # 依赖清单
├── templates/
│   └── index.html      # 主页面
├── static/
│   ├── css/style.css   # 样式
│   └── js/app.js       # 前端逻辑（fetch API）
└── task.db             # SQLite 数据库（首次运行自动创建）
```

## 快速开始

### Windows 一键启动

1. 安装 Python 3 后，双击 [启动脚本](start.bat)，或在 PowerShell 运行 `.\start.bat`。脚本会创建或复用虚拟环境并安装依赖，首次安装通常需要联网。
2. 第一次使用空库或旧库时，输入初始管理员用户名（直接回车选 `admin`），再输入并确认 8–128 字符的独立强密码。没有预设密码，后续启动不重问。旧库会先备份，再把历史任务归到初始管理员名下；请先关闭旧版本服务。
3. 按需配置 AI。可回车跳过，不影响登录、角色管理和任务功能。看到服务启动后，打开 [http://127.0.0.1:5000](http://127.0.0.1:5000)，使用刚设置的管理员账号登录；停止服务按 `Ctrl+C`。
4. 演示角色时，可在隐私窗口注册并登录普通成员，先创建一条任务；再用管理员在「管理」中打开该用户，取消「普通成员」并只勾选「只读访客」。刷新访客页面后，只能查看本人任务，不能修改或调用 AI。管理员也可用任务旁的「转交」分配任务。

未指定 `SECRET_KEY` 时，Windows 启动器自动在 `%LOCALAPPDATA%\TaskManager\session.key` 创建并复用随机密钥。外部环境变量优先；不要对外共享密钥。双击启动默认开启注册，可在 PowerShell 中先设 `$env:RBAC_ALLOW_REGISTRATION='false'`，再运行 `.\start.bat`。

### 手动启动（Windows / macOS / Linux）

1. **创建并激活虚拟环境**（推荐）：

   ```bash
   # Windows
   python -m venv venv
   venv\Scripts\activate

   # macOS / Linux
   python3 -m venv venv
   source venv/bin/activate
   ```

2. **安装依赖**：

   ```bash
   pip install -r requirements.txt
   ```

3. **启动应用**：

   ```bash
   python launch.py
   ```

4. 在浏览器中打开 **http://127.0.0.1:5000**

> SQLite 数据库文件（`task.db`）与 `tasks` 表会在首次启动时自动创建，
> 无需手动初始化。

## 今天先做什么？

在任务页填写今天的安排（选填），点击「生成建议」。结果会给出首选任务、最多两件后续任务，以及每件任务的推荐理由和第一步。点击建议里的标题可以定位到原任务。

首次双击 `start.bat`，在「是否配置 AI？」处输入 `y` 或「是」，再填写 API 基础地址和 API 密钥。地址默认使用 DeepSeek，密钥输入时会显示星号。启动器会通过 `/models` 获取模型列表；可以选编号，也可以输入 `M` 手动填写模型 ID。获取失败时可以手动填写。

配置完成后，在保存提示处按回车或输入 `y`，以后双击启动会自动读取，不再询问。Windows 下配置保存在 `%LOCALAPPDATA%\TaskManager\llm.json`；其他系统使用 `$XDG_CONFIG_HOME/TaskManager/llm.json`，未设置时使用 `~/.config/TaskManager/llm.json`。**密钥以明文保存在当前用户目录，不在项目仓库中。** 不想留存密钥时输入 `n`，仅本次使用新配置。

要更换配置，在项目目录的 PowerShell 中运行 `.\start.bat --configure-ai`；完成并保存后会替换旧配置，也可以删除本地配置文件后重新启动。如果同时设置了 `LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，普通启动优先使用整套环境变量，不与本地配置混用。直接运行 `python app.py` 时仍通过环境变量配置 AI。

服务需兼容 OpenAI Chat Completions。API 基础地址后会自动追加 `/chat/completions`。如果服务的基础地址包括 `/v1`，请保留它。

点击生成时，后端会向配置的模型服务发送未完成任务的 ID、标题、描述（每条最多 1000 个字符）、项目运行机器的当前时间和你填写的安排。推荐只用于展示。模型服务缺失或调用失败时，仍可正常管理任务。

## AI 分解任务

在「AI 分解任务」中填写目标和约束，例如「两周内完成实习汇报，并至少彩排一次」。点击「生成子任务」，模型会给出 2 至 10 项按执行顺序排列的草稿。可修改标题和描述，或移除不需要的项；点击「批量加入任务列表」才会保存。每个子任务都是一条普通待办，可以独立编辑、完成或删除。

该功能复用上方的 AI 配置。生成时只把目标文字发送给模型服务，不发送现有任务；保存草稿时不调用模型。

## AI 聊天与计划深聊

- 点击页首的「AI 聊天」开始普通对话，不会自动读取你的任务。
- 点击某条任务旁的「聊计划」，就能围绕它讨论如何开始、怎样分步骤、有什么风险或如何验收。每次发送时，服务端读取这条任务最新的标题、描述（最多 4000 字符）和完成状态；不读取其他任务，也不会修改任务。
- 普通聊天和各任务的对话相互独立。关闭窗口后可以在同一页面继续，每个对话保留最近 8 轮；可手动清空，刷新或关闭页面后不保留。
- 聊天沿用上面的 AI 配置。发送后，当前消息、最近最多 8 轮对话和所选任务（仅计划深聊）会交给配置的模型服务。

## REST API

| 方法   | 路径                          | 说明                                |
|--------|-------------------------------|-------------------------------------|
| GET    | `/api/tasks?status=all`       | 获取任务列表（all/active/completed）|
| POST   | `/api/tasks`                  | 新建任务 `{title, description}`     |
| GET    | `/api/tasks/<id>`             | 获取单个任务                        |
| PUT    | `/api/tasks/<id>`             | 更新 标题/描述/完成状态             |
| PATCH  | `/api/tasks/<id>/toggle`      | 切换完成状态                        |
| DELETE | `/api/tasks/<id>`             | 删除任务                            |

## 配置

可选的环境变量：

- `DATABASE_URL`：覆盖 SQLite 文件位置，默认使用项目根目录的数据库。
- `SECRET_KEY`：环境变量优先，设为独立高熵密钥（至少 32 随机字节）。
- `RBAC_BOOTSTRAP_ADMIN_USERNAME` / `RBAC_BOOTSTRAP_ADMIN_PASSWORD`：无控制台的首次初始化必填；初始化后可撤下，口令不会覆盖已初始化账号。
- `RBAC_ALLOW_REGISTRATION`：本地启动默认开启，服务部署默认关闭，可显式设置 `true` / `false`。
- `TASK_STUDIO_ORIGIN`：部署时指定可信站点来源，例如 `https://tasks.example.com`，不带路径或末尾斜杠。

生产环境使用 HTTPS、可信 WSGI 服务器（例如 `gunicorn "app:create_app()"`），不要启用本地 HTTP 模式。应用内限流作用域是单进程；多进程部署应在可信网关落实共享的全局预算与频率限制。完整接口和权限矩阵见 [RBAC 设计](RBAC-DESIGN.md)。

## 恢复管理员

停止应用并确认目标数据库后，在项目根目录运行 `.\.venv\Scripts\python.exe -X utf8 bootstrap.py --recover-admin admin`（将 `admin` 换成实际管理员用户名）。按提示输入并确认新密码。该命令只恢复已经拥有管理员角色的账号，并撤销其旧会话；不会提升普通用户。

## 自动化测试

```powershell
.\.venv\Scripts\python.exe -X utf8 -m unittest -v
```

使用临时 SQLite 库和 LLM 替身，不修改真实任务数据，也不调用付费模型。
