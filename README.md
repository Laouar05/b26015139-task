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
   python app.py
   ```

4. 在浏览器中打开 **http://127.0.0.1:5000**

> SQLite 数据库文件（`task.db`）与 `tasks` 表会在首次启动时自动创建，
> 无需手动初始化。

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

- `DATABASE_URL` —— 覆盖 SQLite 数据库位置（默认 `sqlite:///task.db`）
- `SECRET_KEY` —— Flask 密钥

## 说明

- 开发服务器以 `debug=True` 运行。生产环境请使用 WSGI 服务器，例如 Gunicorn：
  `gunicorn "app:app"`。
