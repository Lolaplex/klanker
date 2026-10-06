"""Compatibility shims for harness tool argv until contract G is merged.

``klanker.turn`` installs these inside the runner.loop process. If harness
already turns ``x-cli`` into ``--flags``, the schema mapper stays off.
``mcp.schedule.add`` always gains ``--prompt`` when the model sent one and
the harness special-case dropped it.
"""

from __future__ import annotations

from typing import Any, Callable


def args_dict(arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        return {}
    inner = arguments.get("arguments")
    if isinstance(inner, dict):
        merged = dict(inner)
        for key, value in arguments.items():
            if key != "arguments":
                merged.setdefault(key, value)
        return merged
    return arguments


def prompt_value(arguments: Any) -> str:
    args = args_dict(arguments)
    value = args.get("prompt")
    if value in (None, ""):
        return ""
    return str(value)


def module_has_xcli(mod: dict[str, Any] | None) -> bool:
    if not isinstance(mod, dict):
        return False
    params = mod.get("parameters")
    if not isinstance(params, dict):
        return False
    props = params.get("properties")
    if not isinstance(props, dict):
        return False
    return any(isinstance(spec, dict) and spec.get("x-cli") for spec in props.values())


def argv_from_schema(mod: dict[str, Any], arguments: Any) -> list[str]:
    """Map a manifest parameter object to CLI argv using ``x-cli``."""
    args = args_dict(arguments)
    raw_argv = args.get("argv")
    if isinstance(raw_argv, list):
        return [str(item) for item in raw_argv]
    params = mod.get("parameters") if isinstance(mod, dict) else None
    props = params.get("properties") if isinstance(params, dict) else None
    if not isinstance(props, dict):
        return []
    out: list[str] = []
    for key, spec in props.items():
        if key == "argv" or not isinstance(spec, dict):
            continue
        xcli = spec.get("x-cli")
        if not isinstance(xcli, str) or not xcli:
            continue
        value = args.get(key)
        if xcli == "positional":
            if value not in (None, "", False):
                out.append(str(value))
            continue
        if spec.get("type") == "boolean" or isinstance(value, bool):
            if value in (True, "true", "1", 1):
                out.append(xcli)
            continue
        if value not in (None, ""):
            out.extend([xcli, str(value)])
    return out


def _orig_maps_flags(orig: Callable[..., list[str]]) -> bool:
    probe = {
        "name": "mcp.klanker.probe",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "string", "description": "n", "x-cli": "--limit"},
            },
        },
    }
    try:
        out = [str(item) for item in orig(probe, {"limit": "3"})]
    except Exception:
        return False
    return "--limit" in out


def extend_schedule_argv(out: list[str], arguments: Any) -> list[str]:
    """Forward prompt/timeout when the harness schedule special-case drops them."""
    prompt = prompt_value(arguments)
    if prompt and "--prompt" not in out:
        out.extend(["--prompt", prompt])
    timeout = args_dict(arguments).get("timeout")
    if timeout in (None, "") and prompt:
        # The harness defaults LLM jobs to 300s, shorter than the approval wait.
        from .routine import default_routine_timeout_sec

        timeout = default_routine_timeout_sec()
    if timeout not in (None, "") and "--timeout" not in out:
        out.extend(["--timeout", str(timeout)])
    return out


def install_argv_shim() -> None:
    try:
        from runner import cordis_tools
    except ImportError:
        return
    orig = cordis_tools._arguments_to_argv
    if getattr(orig, "_klanker_shim", False):
        return
    maps_flags = _orig_maps_flags(orig)

    def wrapped(mod: dict[str, Any], arguments: Any) -> list[str]:
        if module_has_xcli(mod) and not maps_flags:
            return argv_from_schema(mod, arguments)
        out = list(orig(mod, arguments))
        name = str((mod or {}).get("name") or "") if isinstance(mod, dict) else ""
        if name == "mcp.schedule.add":
            return extend_schedule_argv(out, arguments)
        return out

    wrapped._klanker_shim = True  # type: ignore[attr-defined]
    cordis_tools._arguments_to_argv = wrapped
