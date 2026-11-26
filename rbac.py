"""Task data scopes and administrator operations."""
from urllib.parse import urlsplit

from flask import Blueprint, current_app, g, jsonify, request
from sqlalchemy import func, select, update

from api_common import ApiError, invalid, json_body, valid_id
from auth import permission_required, require_permissions, start_write
from llm import ModelListError, PROVIDER_TYPES, _is_local_url, list_models
from models import AIProvider, Role, Task, User, db, timestamp_to_iso, user_roles, utcnow


def text_field(value, limit, label, *, required=False):
    if not isinstance(value, str):
        raise invalid(f'{label}必须为文本。')
    value = value.strip()
    if len(value) > limit or (required and not value):
        raise invalid(f'{label}长度无效（最多 {limit} 个字符）。')
    try:
        value.encode('utf-8')
    except UnicodeError as exc:
        raise invalid(f'{label}含无效字符。') from exc
    return value

bp = Blueprint('admin', __name__, url_prefix='/api/admin')
READ = ('task:read',)
WRITE = (*READ, 'task:write')
ALL_WRITE = (*WRITE, 'task:read_all', 'task:write_all')
ASSIGN = (*ALL_WRITE, 'task:assign')


def task_scope(stmt, principal, action, *, own_only=False):
    if action == 'read':
        require_permissions(*READ)
        wide = 'task:read_all' in g.permissions
    elif action == 'write':
        require_permissions(*WRITE)
        wide = g.permissions.issuperset(ALL_WRITE)
    else:
        raise ValueError('unknown scope action')
    if own_only or not wide:
        stmt = stmt.where(Task.owner_id == principal.id)
    return stmt


def task_missing():
    return ApiError(404, 'TASK_NOT_FOUND', '任务不存在或不可访问。')


def get_task_or_404(task_id, principal, action):
    if not valid_id(task_id):
        raise task_missing()
    task = db.session.scalar(task_scope(select(Task).where(Task.id == task_id), principal, action))
    if task is None:
        raise task_missing()
    return task


def get_user_or_404(user_id):
    user = db.session.get(User, user_id) if valid_id(user_id) else None
    if user is None:
        raise ApiError(404, 'USER_NOT_FOUND', '用户不存在。')
    return user


def serialize_user(user):
    return dict(id=user.id, username=user.username, is_active=user.is_active,
                roles=sorted(role.code for role in user.roles), created_at=timestamp_to_iso(user.created_at),
                updated_at=timestamp_to_iso(user.updated_at))


def user_target(user_id, *permissions):
    actor = start_write(*permissions)
    if actor.id == user_id:
        raise ApiError(403, 'SELF_CHANGE_FORBIDDEN', '不能修改自己的角色或账号状态。')
    return actor, get_user_or_404(user_id)


def ensure_active_admin():
    db.session.flush()
    exists = db.session.scalar(select(User.id).join(user_roles).join(Role).where(
        User.is_active.is_(True), Role.code == 'admin').limit(1))
    if exists is None:
        raise ApiError(409, 'LAST_ACTIVE_ADMIN', '必须保留至少一个有效管理员。')


def audit(action, actor_id, target_id, result):
    current_app.logger.info('rbac action=%s actor=%s target=%s result=%s', action, actor_id, target_id, result)


@bp.after_request
def audit_denial(response):
    if request.method in {'PUT', 'PATCH'} and response.status_code >= 400:
        user = g.get('current_user')
        params = request.view_args or {}
        target = params.get('user_id', params.get('task_id'))
        audit(request.endpoint, user.id if user else None, target, response.status_code)
    return response


@bp.get('/users')
@permission_required('user:manage')
def list_users():
    page = request.args.get('page', '1', type=str)
    limit = request.args.get('limit', '20', type=str)
    query = request.args.get('q', '').strip().lower()
    if not page.isascii() or not page.isdecimal() or len(page) > 8 or not limit.isascii() or not limit.isdecimal() or len(limit) > 3:
        raise invalid('分页参数无效。')
    page, limit = int(page), int(limit)
    if page < 1 or not 1 <= limit <= 100 or len(query) > 32:
        raise invalid('分页或搜索参数无效。')
    stmt = select(User)
    if query:
        stmt = stmt.where(User.username.contains(query, autoescape=True))
    total = db.session.scalar(select(func.count()).select_from(stmt.subquery()))
    users = db.session.scalars(stmt.order_by(User.id).limit(limit).offset((page - 1) * limit))
    return jsonify(items=[serialize_user(user) for user in users], page=page, limit=limit, total=total)


@bp.get('/users/<int:user_id>')
@permission_required('user:manage')
def user_detail(user_id):
    return jsonify(serialize_user(get_user_or_404(user_id)))


@bp.patch('/users/<int:user_id>')
@permission_required('user:manage')
def set_status(user_id):
    active = json_body('is_active').get('is_active')
    if type(active) is not bool:
        raise invalid('is_active 必须为布尔值。')
    actor, user = user_target(user_id, 'user:manage')
    actor_id = actor.id
    if user.is_active != active:
        user.is_active = active
        if not active:
            user.session_version += 1
    ensure_active_admin()
    result = serialize_user(user)
    db.session.commit()
    audit('user.status', actor_id, user_id, f'is_active={active}')
    return jsonify(result)


@bp.get('/roles')
@permission_required('role:manage')
def list_roles():
    roles = db.session.scalars(select(Role).order_by(Role.id))
    return jsonify(roles=[dict(code=role.code, name=role.name, description=role.description,
                               permissions=sorted(permission.code for permission in role.permissions)) for role in roles])


@bp.put('/users/<int:user_id>/roles')
@permission_required('user:manage', 'role:manage')
def set_roles(user_id):
    codes = json_body('roles').get('roles')
    if (not isinstance(codes, list) or not 1 <= len(codes) <= 3
            or any(not isinstance(code, str) for code in codes) or len(set(codes)) != len(codes)):
        raise invalid('请选择至少一个有效角色，不能重复。')
    actor, user = user_target(user_id, 'user:manage', 'role:manage')
    actor_id = actor.id
    roles = db.session.scalars(select(Role).where(Role.code.in_(codes))).all()
    if len(roles) != len(codes):
        raise invalid('包含未知角色。')
    before = sorted(role.code for role in user.roles)
    user.roles[:] = roles
    user.updated_at = utcnow()
    ensure_active_admin()
    result = serialize_user(user)
    db.session.commit()
    audit('user.roles', actor_id, user_id, f'{before}->{result["roles"]}')
    return jsonify(result)


@bp.put('/tasks/<int:task_id>/owner')
@permission_required(*ASSIGN)
def transfer_task(task_id):
    owner_id = json_body('owner_id').get('owner_id')
    if not valid_id(owner_id):
        raise invalid('请选择有效的目标用户。')
    actor = start_write(*ASSIGN)
    actor_id = actor.id
    task = get_task_or_404(task_id, actor, 'write')
    owner = get_user_or_404(owner_id)
    if not owner.is_active:
        raise ApiError(409, 'OWNER_INACTIVE', '目标账号已禁用。')
    old_owner = task.owner_id
    task.owner_id = owner_id
    db.session.flush()
    result = task.to_dict()
    db.session.commit()
    audit('task.owner', actor_id, task_id, f'{old_owner}->{owner_id}')
    return jsonify(result)


def validate_provider_url(value):
    url_text = text_field(value, 500, 'API 基础地址', required=True)
    parsed = urlsplit(url_text)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.query or parsed.fragment:
        raise invalid('请输入有效的 HTTP/HTTPS API 基础地址（不含查询参数）。')
    return url_text.rstrip('/')


def validate_provider_type(value):
    kind = (value if isinstance(value, str) else '').strip().lower()
    if kind not in PROVIDER_TYPES:
        raise invalid('接口协议仅支持 openai 或 gemini。')
    return kind


def validate_provider_model(value):
    model = text_field(value, 120, '模型名称', required=True)
    if not model.isprintable():
        raise invalid('模型名称含无效字符。')
    return model


def validate_provider_key(value, provider_type, base_url):
    key = text_field(value if value is not None else '', 500, 'API 密钥')
    needs_key = not (provider_type == 'openai' and _is_local_url(base_url))
    if needs_key and not key:
        raise invalid('请填写 API 密钥（仅本机 OpenAI 兼容服务可留空）。')
    return key


def get_provider_or_404(provider_id):
    provider = db.session.get(AIProvider, provider_id) if valid_id(provider_id) else None
    if provider is None:
        raise ApiError(404, 'PROVIDER_NOT_FOUND', 'AI 提供商不存在。')
    return provider


def env_llm_summary():
    cfg = current_app.config
    base = (cfg.get('LLM_BASE_URL') or '').strip()
    key = (cfg.get('LLM_API_KEY') or '').strip()
    model = (cfg.get('LLM_MODEL') or '').strip()
    configured = bool(base and model and (key or _is_local_url(base)))
    return dict(configured=configured, model=model if configured else '', base_url=base if configured else '')


@bp.get('/ai-providers')
@permission_required('role:manage')
def list_ai_providers():
    providers = db.session.scalars(
        select(AIProvider).order_by(AIProvider.is_active.desc(), AIProvider.id.asc())
    ).all()
    return jsonify(items=[p.to_dict() for p in providers], env_fallback=env_llm_summary())


@bp.post('/ai-providers')
@permission_required('role:manage')
def create_ai_provider():
    data = json_body('name', 'provider_type', 'base_url', 'api_key', 'model', 'activate')
    name = text_field(data.get('name'), 80, '提供商名称', required=True)
    provider_type = validate_provider_type(data.get('provider_type', 'openai'))
    base_url = validate_provider_url(data.get('base_url'))
    api_key = validate_provider_key(data.get('api_key', ''), provider_type, base_url)
    model = validate_provider_model(data.get('model'))
    activate = data.get('activate', True)
    if type(activate) is not bool:
        raise invalid('activate 必须为布尔值。')

    actor = start_write('role:manage')
    actor_id = actor.id
    if activate:
        db.session.execute(update(AIProvider).values(is_active=False))
    provider = AIProvider(
        name=name, provider_type=provider_type, base_url=base_url,
        api_key=api_key, model=model, is_active=activate,
    )
    db.session.add(provider)
    db.session.flush()
    result = provider.to_dict()
    db.session.commit()
    audit('ai_provider.create', actor_id, result['id'], f'{provider_type}:{model}:active={activate}')
    return jsonify(result), 201


@bp.put('/ai-providers/<int:provider_id>')
@permission_required('role:manage')
def update_ai_provider(provider_id):
    data = json_body('name', 'provider_type', 'base_url', 'api_key', 'clear_api_key', 'model', 'activate')
    actor = start_write('role:manage')
    actor_id = actor.id
    provider = get_provider_or_404(provider_id)

    name = text_field(data['name'], 80, '提供商名称', required=True) if 'name' in data else provider.name
    provider_type = validate_provider_type(data['provider_type']) if 'provider_type' in data else provider.provider_type
    base_url = validate_provider_url(data['base_url']) if 'base_url' in data else provider.base_url
    model = validate_provider_model(data['model']) if 'model' in data else provider.model

    clear_key = data.get('clear_api_key', False)
    if type(clear_key) is not bool:
        raise invalid('clear_api_key 必须为布尔值。')
    if clear_key:
        raw_key = ''
    elif 'api_key' in data and isinstance(data['api_key'], str) and data['api_key'].strip():
        raw_key = data['api_key']
    elif 'api_key' in data and not isinstance(data['api_key'], str):
        raise invalid('API 密钥须为文本。')
    else:
        raw_key = provider.api_key
    api_key = validate_provider_key(raw_key, provider_type, base_url)

    provider.name = name
    provider.provider_type = provider_type
    provider.base_url = base_url
    provider.api_key = api_key
    provider.model = model
    if 'activate' in data:
        if type(data['activate']) is not bool:
            raise invalid('activate 必须为布尔值。')
        if data['activate']:
            db.session.execute(update(AIProvider).where(AIProvider.id != provider.id).values(is_active=False))
            provider.is_active = True
        else:
            provider.is_active = False

    db.session.flush()
    result = provider.to_dict()
    db.session.commit()
    audit('ai_provider.update', actor_id, provider_id, f'{provider_type}:{model}')
    return jsonify(result)


@bp.post('/ai-providers/<int:provider_id>/activate')
@permission_required('role:manage')
def activate_ai_provider(provider_id):
    if request.content_length or request.is_json:
        json_body()
    actor = start_write('role:manage')
    actor_id = actor.id
    provider = get_provider_or_404(provider_id)
    db.session.execute(update(AIProvider).values(is_active=False))
    provider.is_active = True
    db.session.flush()
    result = provider.to_dict()
    db.session.commit()
    audit('ai_provider.activate', actor_id, provider_id, f'{provider.provider_type}:{provider.model}')
    return jsonify(result)


@bp.delete('/ai-providers/<int:provider_id>')
@permission_required('role:manage')
def delete_ai_provider(provider_id):
    if request.content_length or request.is_json:
        json_body()
    actor = start_write('role:manage')
    actor_id = actor.id
    provider = get_provider_or_404(provider_id)
    db.session.delete(provider)
    db.session.commit()
    audit('ai_provider.delete', actor_id, provider_id, 'deleted')
    return '', 204


@bp.post('/ai-providers/models')
@permission_required('role:manage')
def fetch_ai_provider_models():
    data = json_body('provider_type', 'base_url', 'api_key', 'provider_id')
    provider_type = validate_provider_type(data.get('provider_type', 'openai'))
    base_url = validate_provider_url(data.get('base_url'))
    raw_key = data.get('api_key', '')
    if not isinstance(raw_key, str):
        raise invalid('API 密钥须为文本。')
    api_key = raw_key.strip()
    if not api_key and data.get('provider_id') is not None:
        stored = get_provider_or_404(data.get('provider_id'))
        api_key = stored.api_key
    api_key = validate_provider_key(api_key, provider_type, base_url)
    db.session.remove()
    try:
        models = list_models(base_url, api_key, provider_type=provider_type)
    except ModelListError as exc:
        raise ApiError(502, 'AI_UPSTREAM_ERROR', str(exc)) from exc
    return jsonify(models=models)
