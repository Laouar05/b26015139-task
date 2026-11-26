"""Task Studio application factory and task / AI API."""
from datetime import datetime
import logging
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, render_template, request
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from werkzeug.exceptions import HTTPException

from api_common import ApiError, fields, invalid, json_body, valid_id
from auth import init_auth, login_required, new_snapshot, permission_required, rate_limits, require_permissions, start_write
from bootstrap import BootstrapError, initialize_database
from config import Config, sqlite_url
from llm import LLMError, _is_local_url, chat_reply, decompose_task, recommend_tasks, validate_task_batch
from models import AIProvider, Task, db, enable_sqlite_foreign_keys
from rbac import READ, WRITE, bp as admin_bp, get_task_or_404, task_missing, task_scope


def text_field(value, limit, label, *, required=False):
    if not isinstance(value, str):
        raise invalid(f'{label}必须为文本。')
    value = value.strip()
    if len(value) > limit or required and not value:
        raise invalid(f'{label}长度无效（最多 {limit} 个字符）。')
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise invalid(f'{label}含无效字符。') from None
    return value


def validate_chat_messages(entries):
    if not isinstance(entries, list) or not 1 <= len(entries) <= 17 or len(entries) % 2 == 0:
        raise invalid('请提供当前消息和最多 8 轮历史对话。')
    messages = []
    for index, entry in enumerate(entries):
        role, limit = ('user', 2000) if index % 2 == 0 else ('assistant', 4000)
        fields(entry, ('role', 'content'))
        if entry.get('role') != role:
            raise invalid('对话消息须按用户和 AI 的顺序交替排列。')
        messages.append(dict(role=role, content=text_field(entry.get('content'), limit, '对话消息', required=True)))
    return messages


def create_app(overrides=None):
    app = Flask(__name__)
    app.logger.setLevel(logging.INFO)
    app.config.from_mapping(Config.from_env())
    app.config.update(overrides or {})
    secret = app.config['SECRET_KEY']
    if not isinstance(secret, str) or len(secret.encode('utf-8')) < 32:
        raise ValueError('SECRET_KEY 须为独立高熵密钥（至少 32 字节）。本地请通过 start.bat 启动。')
    app.config['SQLALCHEMY_DATABASE_URI'] = sqlite_url(app.config['SQLALCHEMY_DATABASE_URI'])
    origin = app.config['TASK_STUDIO_ORIGIN']
    if origin:
        origin_parts = urlsplit(origin)
        if origin_parts.scheme not in ('http', 'https') or not origin_parts.hostname or origin_parts.username or origin_parts.path or origin_parts.query or origin_parts.fragment:
            raise ValueError('TASK_STUDIO_ORIGIN 须为不带路径的站点来源。')

    @app.before_request
    def trusted_host():
        if origin and request.host.lower() != origin_parts.netloc.lower():
            raise ApiError(400, 'INVALID_HOST', '站点地址不匹配。')

    db.init_app(app)
    with app.app_context():
        enable_sqlite_foreign_keys(db.engine)
        try:
            initialize_database(app)
        except Exception:
            db.engine.dispose()
            raise
    app.config.pop('RBAC_BOOTSTRAP_ADMIN_PASSWORD', None)
    init_auth(app)
    app.register_blueprint(admin_bp)
    register_routes(app)
    register_errors(app)
    return app


def resolve_llm_config(app):
    active = db.session.scalar(select(AIProvider).where(AIProvider.is_active.is_(True)).limit(1))
    if active is not None:
        return {
            'LLM_PROVIDER_TYPE': active.provider_type,
            'LLM_BASE_URL': active.base_url,
            'LLM_API_KEY': active.api_key,
            'LLM_MODEL': active.model,
        }
    return app.config


def begin_ai(app):
    rate_limits().take((('ai-user', g.current_user.id), 10), (('ai-global',), 60))
    llm_config = resolve_llm_config(app)
    db.session.remove()
    return llm_config


def register_routes(app):
    @app.get('/')
    def index():
        return render_template('index.html')

    @app.get('/api/ai/active')
    @login_required
    def active_ai_provider():
        active = db.session.scalar(select(AIProvider).where(AIProvider.is_active.is_(True)).limit(1))
        if active is not None:
            return jsonify(
                configured=True,
                source='database',
                name=active.name,
                provider_type=active.provider_type,
                model=active.model,
            )
        base = (app.config.get('LLM_BASE_URL') or '').strip()
        key = (app.config.get('LLM_API_KEY') or '').strip()
        model = (app.config.get('LLM_MODEL') or '').strip()
        configured = bool(base and model and (key or _is_local_url(base)))
        return jsonify(
            configured=configured,
            source='env' if configured else 'none',
            name='默认环境配置' if configured else '',
            provider_type='openai' if configured else '',
            model=model if configured else '',
        )

    @app.post('/api/chat')
    @permission_required('ai:chat')
    def chat():
        data = json_body('messages', 'task_id')
        messages = validate_chat_messages(data.get('messages'))
        context = None
        task_id = data.get('task_id')
        if task_id is not None:
            require_permissions(*READ)
            if not valid_id(task_id):
                raise invalid('任务 ID 无效。')
            task = get_task_or_404(task_id, g.current_user, 'read')
            context = dict(title=task.title, description=(task.description or '')[:4000], completed=task.completed)
        llm_config = begin_ai(app)
        reply = chat_reply(llm_config, messages, context)
        actor = new_snapshot('ai:chat', *READ) if context is not None else new_snapshot('ai:chat')
        if context is not None:
            get_task_or_404(task_id, actor, 'read')
        return jsonify(reply=reply)

    @app.post('/api/recommendations/today')
    @permission_required('ai:recommend', *READ)
    def today_recommendations():
        data = json_body('context', 'scope')
        context = text_field(data.get('context', ''), 300, '今天的安排')
        scope = data.get('scope', 'own')
        if scope not in ('own', 'all'):
            raise invalid('任务范围无效。')
        codes = ('ai:recommend', *READ, *(['task:read_all'] if scope == 'all' else []))
        actor = require_permissions(*codes)
        stmt = select(Task.id, Task.title, Task.description).where(Task.completed.is_(False))
        stmt = task_scope(stmt, actor, 'read', own_only=scope == 'own')
        rows = db.session.execute(stmt.order_by(Task.created_at.desc(), Task.id.desc()).limit(30))
        tasks = [dict(id=task_id, title=title, description=(description or '')[:1000])
                 for task_id, title, description in rows]
        if not tasks:
            return jsonify(recommendations=[])
        llm_config = begin_ai(app)
        recommendations = recommend_tasks(llm_config, tasks, context, datetime.now().astimezone().isoformat(timespec='minutes'))
        actor = new_snapshot(*codes)
        ids = {task['id'] for task in tasks}
        recheck = task_scope(select(Task.id).where(Task.id.in_(ids)), actor, 'read', own_only=scope == 'own')
        if set(db.session.scalars(recheck)) != ids:
            raise task_missing()
        return jsonify(recommendations=recommendations)

    @app.post('/api/tasks/decompose')
    @permission_required('ai:decompose')
    def draft_tasks():
        goal = text_field(json_body('goal').get('goal'), 2000, '大任务目标', required=True)
        llm_config = begin_ai(app)
        tasks = decompose_task(llm_config, goal)
        new_snapshot('ai:decompose')
        return jsonify(tasks=tasks)

    @app.post('/api/tasks/batch')
    @permission_required('task:write')
    def create_tasks():
        entries = json_body('tasks').get('tasks')
        if isinstance(entries, list) and len(entries) <= 10:
            for entry in entries:
                fields(entry, ('title', 'description'))
        try:
            entries = validate_task_batch(entries)
        except ValueError as exc:
            raise invalid(str(exc)) from exc
        owner_id = start_write('task:write').id
        tasks = [Task(owner_id=owner_id, **entry) for entry in entries]
        db.session.add_all(reversed(tasks))
        db.session.flush()
        result = [task.to_dict() for task in tasks]
        db.session.commit()
        return jsonify(tasks=result), 201

    @app.get('/api/tasks')
    @permission_required(*READ)
    def list_tasks():
        status = request.args.get('status', 'all')
        stmt = task_scope(select(Task), g.current_user, 'read')
        if status in ('active', 'completed'):
            stmt = stmt.where(Task.completed.is_(status == 'completed'))
        return jsonify([task.to_dict() for task in db.session.scalars(stmt.order_by(Task.created_at.desc(), Task.id.desc()))])

    @app.post('/api/tasks')
    @permission_required('task:write')
    def create_task():
        data = json_body('title', 'description')
        title = text_field(data.get('title'), 200, '标题', required=True)
        description = text_field(data.get('description', ''), 10000, '描述')
        owner_id = start_write('task:write').id
        task = Task(title=title, description=description, owner_id=owner_id)
        db.session.add(task)
        return save_task(task), 201

    @app.get('/api/tasks/<int:task_id>')
    @permission_required(*READ)
    def get_task(task_id):
        return jsonify(get_task_or_404(task_id, g.current_user, 'read').to_dict())

    @app.put('/api/tasks/<int:task_id>')
    @permission_required(*WRITE)
    def update_task(task_id):
        actor = start_write(*WRITE)
        task = get_task_or_404(task_id, actor, 'write')
        data = json_body('title', 'description', 'completed')
        if 'title' in data:
            task.title = text_field(data['title'], 200, '标题', required=True)
        if 'description' in data:
            task.description = text_field(data['description'], 10000, '描述')
        if 'completed' in data:
            if type(data['completed']) is not bool:
                raise invalid('完成状态须为布尔值。')
            task.completed = data['completed']
        return save_task(task)

    @app.patch('/api/tasks/<int:task_id>/toggle')
    @permission_required(*WRITE)
    def toggle_task(task_id):
        actor = start_write(*WRITE)
        task = get_task_or_404(task_id, actor, 'write')
        if request.content_length or request.is_json:
            json_body()
        task.completed = not task.completed
        return save_task(task)

    @app.delete('/api/tasks/<int:task_id>')
    @permission_required(*WRITE)
    def delete_task(task_id):
        actor = start_write(*WRITE)
        task = get_task_or_404(task_id, actor, 'write')
        if request.content_length or request.is_json:
            json_body()
        db.session.delete(task)
        db.session.commit()
        return '', 204


def save_task(task):
    db.session.flush()
    result = jsonify(task.to_dict())
    db.session.commit()
    return result


def register_errors(app):
    @app.after_request
    def no_store(response):
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(ApiError)
    def api_error(exc):
        db.session.rollback()
        return exc.response()

    @app.errorhandler(LLMError)
    def llm_error(exc):
        if exc.status == 503:
            return ApiError(503, 'AI_UNAVAILABLE', 'AI 服务未配置或暂不可用。').response()
        if exc.status == 504:
            return ApiError(504, 'AI_UPSTREAM_ERROR', 'AI 服务响应超时，请稍后重试。').response()
        return ApiError(502, 'AI_UPSTREAM_ERROR', 'AI 服务返回异常，请稍后重试。').response()

    @app.errorhandler(HTTPException)
    def http_error(exc):
        if not request.path.startswith('/api/'):
            return exc
        code, message = {
            404: ('NOT_FOUND', '资源不存在。'), 405: ('METHOD_NOT_ALLOWED', '请求方法不允许。'),
            413: ('REQUEST_TOO_LARGE', '请求体过长。'), 500: ('INTERNAL_ERROR', '服务器内部错误。'),
        }.get(exc.code, ('HTTP_ERROR', '请求失败。'))
        db.session.rollback()
        response = ApiError(exc.code, code, message).response()
        allow = exc.get_response().headers.get('Allow')
        if allow:
            response.headers['Allow'] = allow
        return response

    @app.errorhandler(OperationalError)
    def database_error(exc):
        db.session.rollback()
        if getattr(exc.orig, 'sqlite_errorcode', 0) & 0xff in (5, 6):
            return ApiError(503, 'DB_BUSY', '数据库繁忙，请重试。').response()
        app.logger.error('SQLite operation failed: %s', getattr(exc.orig, 'sqlite_errorname', 'unknown'))
        return ApiError(500, 'INTERNAL_ERROR', '服务器内部错误。').response()


if __name__ == '__main__':
    try:
        application = create_app()
    except (BootstrapError, ValueError, OSError, OperationalError) as exc:
        raise SystemExit(f'启动失败：{exc}') from None
    application.run(debug=False, host='127.0.0.1', port=5000)
