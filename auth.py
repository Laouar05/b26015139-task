"""Flask session authentication, CSRF and local rate limits."""
from collections import defaultdict
from functools import wraps
from secrets import compare_digest, token_urlsafe
from threading import Lock
from time import monotonic

from flask import Blueprint, current_app, g, jsonify, request, session
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash

from api_common import ApiError, invalid, json_body, valid_id
from credentials import normalize_username, validate_password
from models import Role, User, db

bp = Blueprint('auth', __name__, url_prefix='/api/auth')
SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}


class RateLimits:
    def __init__(self):
        self.lock = Lock()
        self.counts = defaultdict(int)
        self.minute = -1

    def take(self, *buckets):
        now = int(monotonic())
        minute, seconds = divmod(now, 60)
        with self.lock:
            if self.minute != minute:
                self.counts.clear()
                self.minute = minute
            if any(self.counts[key] >= limit for key, limit in buckets):
                raise ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', retry_after=60 - seconds)
            for key, _limit in buckets:
                self.counts[key] += 1


def rate_limits():
    return current_app.extensions['task_studio_rate_limits']


def load_current_user():
    g.current_user = None
    g.permissions = frozenset()
    if not request.path.startswith('/api/'):
        return
    uid, version = session.get('uid'), session.get('ver')
    if uid is None and version is None:
        return
    if valid_id(uid) and type(version) is int:
        if not db.session().in_transaction():
            db.session.connection().exec_driver_sql('BEGIN')
        user = db.session.get(User, uid)
    else:
        user = None
    if not user or not user.is_active or user.session_version != version:
        session.clear()
        return
    g.current_user = user
    g.permissions = frozenset(permission.code for role in user.roles for permission in role.permissions)


def require_permissions(*codes):
    if g.current_user is None:
        raise ApiError(401, 'AUTH_REQUIRED', '请先登录。')
    if not g.permissions.issuperset(codes):
        raise ApiError(403, 'PERMISSION_DENIED', '没有执行此操作的权限。')
    return g.current_user


def check_csrf():
    token = request.headers.get('X-CSRF-Token', '')
    expected = session.get('csrf_token')
    origin = request.headers.get('Origin')
    trusted = current_app.config.get('TASK_STUDIO_ORIGIN') or request.host_url.rstrip('/')
    if (origin is not None and origin != trusted or not expected or not token.isascii()
            or not compare_digest(token, expected)):
        raise ApiError(403, 'CSRF_INVALID', '安全令牌已失效，请重新提交。')


def permission_required(*codes):
    def decorate(view):
        @wraps(view)
        def guarded(*args, **kwargs):
            require_permissions(*codes)
            if request.method not in SAFE_METHODS:
                check_csrf()
            return view(*args, **kwargs)
        return guarded
    return decorate


def login_required(view):
    return permission_required()(view)


def new_snapshot(*codes):
    db.session.remove()
    load_current_user()
    return require_permissions(*codes)


def start_write(*codes):
    db.session.remove()
    db.session.connection().exec_driver_sql('BEGIN IMMEDIATE')
    load_current_user()
    return require_permissions(*codes)


def identity(user):
    return dict(user=dict(id=user.id, username=user.username),
                roles=sorted(role.code for role in user.roles), permissions=sorted(g.permissions))


@bp.get('/csrf')
def csrf():
    if 'csrf_token' not in session:
        session['csrf_token'] = token_urlsafe(32)
    return jsonify(csrf_token=session['csrf_token'],
                   registration_enabled=current_app.config['RBAC_ALLOW_REGISTRATION'])


@bp.post('/register')
def register():
    if not current_app.config['RBAC_ALLOW_REGISTRATION']:
        raise ApiError(403, 'REGISTRATION_DISABLED', '当前不开放注册。')
    check_csrf()
    rate_limits().take((('register-ip', request.remote_addr), 10))
    data = json_body('username', 'password')
    try:
        name = normalize_username(data.get('username'))
        password = validate_password(data.get('password'))
    except ValueError as exc:
        raise invalid(str(exc)) from exc
    password_hash = generate_password_hash(password, method='scrypt')
    member = db.session.scalar(select(Role).where(Role.code == 'member'))
    if member is None:
        raise ApiError(500, 'INTERNAL_ERROR', '注册暂不可用。')
    user = User(username=name, password_hash=password_hash, roles=[member])
    db.session.add(user)
    try:
        db.session.flush()
        result = dict(id=user.id, username=user.username)
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        if 'UNIQUE constraint failed: users.username' not in str(exc.orig):
            raise
        raise ApiError(409, 'USERNAME_TAKEN', '该用户名不可用。') from None
    return jsonify(result), 201


@bp.post('/login')
def login():
    check_csrf()
    rate_limits().take((('login-ip', request.remote_addr), 30))
    data = json_body('username', 'password')
    try:
        name = normalize_username(data.get('username'))
    except ValueError:
        name = None
    password = data.get('password')
    if not isinstance(password, str) or not 1 <= len(password) <= 128:
        password = ''
    try:
        password.encode('utf-8')
    except UnicodeError:
        password = ''
    if name:
        rate_limits().take((('login-account', name), 10))
    user = db.session.scalar(select(User).where(User.username == name)) if name else None
    target_hash = user.password_hash if user and user.is_active else current_app.extensions['task_studio_dummy_hash']
    matches = check_password_hash(target_hash, password)
    if not matches or not user or not user.is_active:
        raise ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。')
    session.clear()
    session.permanent = True
    session.update(uid=user.id, ver=user.session_version, csrf_token=token_urlsafe(32))
    g.permissions = frozenset(permission.code for role in user.roles for permission in role.permissions)
    return jsonify(**identity(user), csrf_token=session['csrf_token'])


@bp.get('/me')
@login_required
def me():
    return jsonify(identity(g.current_user))


@bp.post('/logout')
@login_required
def logout():
    user = start_write()
    user.session_version += 1
    db.session.commit()
    session.clear()
    return '', 204


def init_auth(app):
    app.extensions['task_studio_rate_limits'] = RateLimits()
    app.extensions['task_studio_dummy_hash'] = generate_password_hash(token_urlsafe(32), method='scrypt')
    app.register_blueprint(bp)
    app.before_request(load_current_user)
