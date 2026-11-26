"""Environment-driven Task Studio settings."""
from datetime import timedelta
from pathlib import Path
import os

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATABASE_URI = URL.create('sqlite', database=str(BASE_DIR / 'task.db')).render_as_string()


def sqlite_url(uri):
    try:
        url = make_url(uri)
    except ArgumentError as exc:
        raise ValueError('DATABASE_URL 须是有效的 SQLite URL。') from exc
    if url.drivername not in ('sqlite', 'sqlite+pysqlite') or url.query or url.host or url.username or url.password or url.port:
        raise ValueError('仅支持普通 SQLite 文件 URL，不支持 URI 参数。')
    if url.database and url.database != ':memory:':
        path = Path(url.database)
        if not path.is_absolute():
            path = BASE_DIR / 'instance' / path
        url = url.set(database=str(path.resolve()))
    return url


def boolean(env, key, default=False):
    value = env.get(key)
    if value is None:
        return default
    value = value.strip().lower()
    if value in ('1', 'true', 'yes', 'on'):
        return True
    if value in ('0', 'false', 'no', 'off'):
        return False
    raise ValueError(f'{key} 须为 true 或 false。')


class Config:
    @staticmethod
    def from_env(env=None):
        env = os.environ if env is None else env
        local = boolean(env, 'TASK_STUDIO_LOCAL')
        return dict(
            SECRET_KEY=env.get('SECRET_KEY'),
            SQLALCHEMY_DATABASE_URI=env.get('DATABASE_URL') or DEFAULT_DATABASE_URI,
            SQLALCHEMY_TRACK_MODIFICATIONS=False,
            MAX_CONTENT_LENGTH=768 * 1024,
            SESSION_COOKIE_NAME='chengxu_session', SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=not local,
            SESSION_COOKIE_PATH='/', SESSION_REFRESH_EACH_REQUEST=False,
            PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
            TASK_STUDIO_ORIGIN=env.get('TASK_STUDIO_ORIGIN') or ('http://127.0.0.1:5000' if local else None),
            RBAC_ALLOW_REGISTRATION=boolean(env, 'RBAC_ALLOW_REGISTRATION', local),
            RBAC_BOOTSTRAP_ADMIN_USERNAME=env.get('RBAC_BOOTSTRAP_ADMIN_USERNAME'),
            RBAC_BOOTSTRAP_ADMIN_PASSWORD=env.get('RBAC_BOOTSTRAP_ADMIN_PASSWORD'),
            LLM_BASE_URL=env.get('LLM_BASE_URL', '').strip(),
            LLM_API_KEY=env.get('LLM_API_KEY', '').strip(),
            LLM_MODEL=env.get('LLM_MODEL', '').strip(),
        )
