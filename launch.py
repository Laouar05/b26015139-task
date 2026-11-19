"""Configure the optional AI feature in the console before starting Flask."""
import argparse
import json
import os
import subprocess
import sys
from getpass import getpass
from pathlib import Path
from tempfile import NamedTemporaryFile

from llm import ModelListError, list_models


LLM_KEYS = ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY")


def read_api_key():
    if sys.platform != "win32":
        return getpass("API 密钥（输入时隐藏）：")

    from msvcrt import getwch

    print("API 密钥（输入时显示星号）：", end="", flush=True)
    characters = []
    try:
        while True:
            char = getwch()
            if char in ("\r", "\n"):
                return "".join(characters)
            if char == "\x03":
                raise KeyboardInterrupt
            if char in ("\x00", "\xe0"):
                getwch()  # Discard the second part of a special key.
            elif char == "\b":
                if characters:
                    characters.pop()
                    print("\b \b", end="", flush=True)
            elif char.isprintable():
                characters.append(char)
                print("*", end="", flush=True)
    finally:
        print(flush=True)


def select_model(base_url, api_key, default_model):
    print("正在获取模型列表……", flush=True)
    try:
        models = list_models(base_url, api_key)
    except ModelListError as exc:
        print(exc, flush=True)
    else:
        for index, model_id in enumerate(models, start=1):
            print(f"  {index}. {model_id}")
        while True:
            choice = input("输入模型编号，输入 M 手动填写，或按回车跳过 AI 配置：").strip()
            if not choice:
                return ""
            if choice.lower() == "m":
                break
            try:
                index = int(choice)
            except ValueError:
                index = 0
            if 1 <= index <= len(models):
                return models[index - 1]
            print("请输入列表中的模型编号。")

    if default_model:
        return input(f"手动输入模型 ID，按回车沿用 {default_model}：").strip() or default_model
    return input("手动输入模型 ID，或按回车跳过 AI 配置：").strip()


def user_config_path():
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return root / "TaskManager" / "llm.json"


def complete_config(values):
    return isinstance(values, dict) and all(
        isinstance(values.get(key), str) and values[key].strip() for key in LLM_KEYS
    )


def load_ai_config(path):
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
        if complete_config(values):
            return {key: values[key].strip() for key in LLM_KEYS}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, RecursionError):
        pass
    print("无法读取已保存的 AI 配置，可以重新填写。", flush=True)
    return {}


def save_ai_config(path, values):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary_path = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary_path = Path(stream.name)
            json.dump(values, stream, ensure_ascii=False, indent=2)
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def configure_ai(env, *, force=False):
    from_env = complete_config(env)
    if from_env and not force:
        print("已沿用环境变量中的 AI 配置。", flush=True)
        return

    path = user_config_path()
    saved = load_ai_config(path)
    if saved and not from_env:
        env.update(saved)
        if not force:
            print("已载入本地保存的 AI 配置。", flush=True)
            return
    if not sys.stdin.isatty():
        return

    try:
        choice = input("是否配置 AI？输入 y 或「是」继续，直接按回车维持现状：").strip().lower()
        if choice not in ("y", "是"):
            return

        current_url = env.get("LLM_BASE_URL", "").strip()
        default_url = current_url or "https://api.deepseek.com"
        base_url = input(f"API 基础地址（默认 {default_url}）：").strip() or default_url
        api_key = read_api_key().strip()
        if not api_key:
            print("未填写 API 密钥，原配置不变。", flush=True)
            return
        default_model = env.get("LLM_MODEL", "").strip() if base_url == current_url else ""
        model = select_model(base_url, api_key, default_model)
    except EOFError:
        return

    if not model:
        return
    values = dict(LLM_BASE_URL=base_url, LLM_MODEL=model, LLM_API_KEY=api_key)
    env.update(values)
    print("已配置本次运行的 AI 设置。", flush=True)
    try:
        keep = input("保存配置供下次启动使用？API 密钥会以明文保存在当前用户目录（Y/n）：").strip().lower()
    except EOFError:
        return
    if keep not in ("", "y", "yes", "是"):
        return
    try:
        save_ai_config(path, values)
    except OSError:
        print("无法保存 AI 配置，本次运行仍可使用。", flush=True)
        return
    print("已保存 AI 配置。", flush=True)
    if from_env:
        print("下次普通启动时，完整的环境变量配置仍优先。", flush=True)


def main():
    parser = argparse.ArgumentParser(description="配置并启动任务管理器。")
    parser.add_argument("--configure-ai", action="store_true", help="重新配置本地 AI 设置")
    args = parser.parse_args()
    env = os.environ.copy()
    configure_ai(env, force=args.configure_ai)
    print("正在启动任务管理器，访问地址为 http://127.0.0.1:5000", flush=True)
    print("按 Ctrl+C 停止服务。", flush=True)
    return subprocess.call([sys.executable, "app.py"], env=env)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
