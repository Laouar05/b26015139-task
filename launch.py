"""Configure the optional AI feature in the console before starting Flask."""
import os
import subprocess
import sys
from getpass import getpass

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


def configure_ai(env):
    if all(env.get(key, "").strip() for key in LLM_KEYS):
        print("已沿用环境变量中的 AI 配置。", flush=True)
        return
    if not sys.stdin.isatty():
        return

    try:
        choice = input("是否为本次运行配置 AI？输入 y 或「是」继续，直接按回车跳过：").strip().lower()
        if choice not in ("y", "是"):
            return

        default_url = env.get("LLM_BASE_URL", "").strip() or "https://api.deepseek.com"
        base_url = input(f"API 基础地址（默认 {default_url}）：").strip() or default_url
        api_key = read_api_key().strip() or env.get("LLM_API_KEY", "").strip()
        if not api_key:
            print("API 密钥未填写，本次将跳过 AI 配置。", flush=True)
            return
        model = select_model(base_url, api_key, env.get("LLM_MODEL", "").strip())
    except EOFError:
        return

    if not model:
        return
    env.update(LLM_BASE_URL=base_url, LLM_MODEL=model, LLM_API_KEY=api_key)
    print("已配置本次运行的 AI 设置。", flush=True)


def main():
    env = os.environ.copy()
    configure_ai(env)
    print("正在启动任务管理器，访问地址为 http://127.0.0.1:5000", flush=True)
    print("按 Ctrl+C 停止服务。", flush=True)
    return subprocess.call([sys.executable, "app.py"], env=env)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
