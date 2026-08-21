export const RLM_PYTHON_WORKER = String.raw`
import ast
import asyncio
import base64
import builtins
import hashlib
import inspect
import io
import itertools
import json
import os
import re
import socket
import subprocess
import sys
import threading
import traceback
import types

try:
    import dill as _dill
except Exception:
    _dill = None

sys.dont_write_bytecode = True
_control = os.fdopen(3, "r+b", buffering=0)
_send_lock = threading.Lock()
_namespace = globals()
_access = "closed"
_effects = None
_active_request_id = None
_host_request_counter = 1
_secret_name = re.compile(r"(?:key|token|secret|password|passwd|auth|cookie|credential)", re.I)
_secret_value = re.compile(r"(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,})", re.I)


def _send(payload):
    data = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with _send_lock:
        _control.write(data)
        _control.flush()


def _path(value):
    try:
        return os.fspath(value)
    except Exception:
        return str(value)


def _write_mode(mode):
    if isinstance(mode, str):
        return any(char in mode for char in "wax+")
    if isinstance(mode, int):
        flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
        return bool(mode & flags)
    return False


def _audit(event, args):
    global _effects
    allowed = _access in {"work", "internal"}
    if event == "open" and len(args) > 1 and _write_mode(args[1]):
        target = _path(args[0])
        if _effects is not None:
            _effects["filesWritten"].add(target)
        if not allowed:
            raise PermissionError("RlmKernel inspect mode blocks file writes")
    if event in {"os.remove", "os.rmdir", "os.unlink"}:
        target = _path(args[0]) if args else ""
        if _effects is not None:
            _effects["filesDeleted"].add(target)
        if not allowed:
            raise PermissionError("RlmKernel inspect mode blocks file deletion")
    if event in {"os.rename", "os.replace"}:
        if _effects is not None and len(args) >= 2:
            _effects["filesDeleted"].add(_path(args[0]))
            _effects["filesWritten"].add(_path(args[1]))
        if not allowed:
            raise PermissionError("RlmKernel inspect mode blocks file moves")
    if event in {"os.mkdir", "os.makedirs"}:
        target = _path(args[0]) if args else ""
        if _effects is not None:
            _effects["filesWritten"].add(target)
        if not allowed:
            raise PermissionError("RlmKernel inspect mode blocks directory creation")
    if event in {"subprocess.Popen", "os.system", "os.spawn", "os.posix_spawn"}:
        if _effects is not None:
            _effects["subprocessStarted"] = True
        if not allowed:
            raise PermissionError("RlmKernel inspect mode blocks subprocesses")
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo"} and not allowed:
        raise PermissionError("RlmKernel inspect mode blocks network connections")


sys.addaudithook(_audit)


def _await(value):
    if inspect.isawaitable(value):
        return asyncio.run(value)
    return value


def _compile_exec(body, filename):
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)


def _compile_expr(node, filename):
    expression = ast.Expression(node)
    ast.fix_missing_locations(expression)
    return compile(expression, filename, "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)


def _execute(code, request_id):
    tree = ast.parse(code, filename=f"<rlm-cell-{request_id}>", mode="exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        prefix = tree.body[:-1]
        if prefix:
            _await(eval(_compile_exec(prefix, f"<rlm-cell-{request_id}>"), _namespace, _namespace))
        value = _await(eval(_compile_expr(tree.body[-1].value, f"<rlm-cell-{request_id}>"), _namespace, _namespace))
        if value is not None:
            builtins.print(repr(value))
        return
    _await(eval(_compile_exec(tree.body, f"<rlm-cell-{request_id}>"), _namespace, _namespace))


def _is_secret(value, depth=0, budget=None):
    if budget is None:
        budget = [256]
    if budget[0] <= 0 or depth > 4:
        return False
    budget[0] -= 1
    if isinstance(value, str):
        return bool(_secret_value.search(value))
    if isinstance(value, dict):
        for key, item in itertools.islice(value.items(), 64):
            if isinstance(key, str) and _secret_name.search(key):
                return True
            if _is_secret(item, depth + 1, budget):
                return True
    if isinstance(value, (list, tuple, set, frozenset)):
        return any(_is_secret(item, depth + 1, budget) for item in itertools.islice(value, 64))
    return False


def _safe_preview(value):
    if value is None or isinstance(value, (bool, int, float)):
        return repr(value)
    if isinstance(value, str):
        if _secret_value.search(value):
            return "<redacted>"
        return repr(value[:160] + ("…" if len(value) > 160 else ""))
    if isinstance(value, bytes):
        return f"<bytes len={len(value)}>"
    if isinstance(value, (list, tuple, set, frozenset, dict)):
        return f"<{type(value).__name__} len={len(value)}>"
    module = type(value).__module__
    if module.startswith(("numpy", "torch", "jax")):
        try:
            return f"<{module}.{type(value).__name__} shape={tuple(value.shape)} dtype={value.dtype}>"
        except Exception:
            pass
    return f"<{type(value).__module__}.{type(value).__qualname__}>"


def _inventory():
    items = []
    for name in sorted(_namespace):
        if name.startswith("_") or name in _internal_names:
            continue
        value = _namespace[name]
        items.append({"name": name, "type": f"{type(value).__module__}.{type(value).__qualname__}", "preview": "<redacted>" if _secret_name.search(name) else _safe_preview(value)})
    return items


def _host_request(request_type, payload):
    global _host_request_counter
    if _active_request_id is None:
        raise RuntimeError("RLM host requests are only available during a cell")
    host_request_id = _host_request_counter
    _host_request_counter += 1
    _send({"id": _active_request_id, "type": "host.request", "hostRequestId": host_request_id, "requestType": request_type, "payload": payload})
    raw = _control.readline()
    if not raw:
        raise RuntimeError("RLM host bridge closed before responding")
    response = json.loads(raw.decode("utf-8"))
    if response.get("type") != "host.response" or response.get("hostRequestId") != host_request_id:
        raise RuntimeError("RLM host bridge returned an unexpected response")
    if not response.get("ok"):
        raise RuntimeError(response.get("error") or "RLM host request failed")
    value = response.get("value")
    if isinstance(value, dict) and value.get("is_error"):
        raise RuntimeError(str(value.get("output") or "RLM host tool failed"))
    return value


def _task_id(value):
    if isinstance(value, dict):
        if isinstance(value.get("task_id"), str):
            return value["task_id"]
        task = value.get("task")
        if isinstance(task, dict) and isinstance(task.get("task_id"), str):
            return task["task_id"]
    return value


def _timeout_seconds(value):
    if isinstance(value, (int, float)) and value > 86400:
        return max(1, int(value / 1000))
    return value


class _RlmTaskApi:
    async def run(self, command, cwd=None, timeout=600, description=None, disable_timeout=False):
        return _host_request("task.run", {"command": command, "cwd": cwd, "timeout": _timeout_seconds(timeout), "description": description or command[:80], "disable_timeout": disable_timeout})

    async def list(self, active_only=True, limit=20):
        return _host_request("task.list", {"active_only": active_only, "limit": limit})

    async def output(self, task_id):
        return _host_request("task.output", {"task_id": _task_id(task_id)})

    async def wait(self, task_id=None, timeout=600):
        return _host_request("task.wait", {"task_id": _task_id(task_id), "timeout": _timeout_seconds(timeout)})

    async def stop(self, task_id, reason="Stopped by rlm.task.stop"):
        return _host_request("task.stop", {"task_id": _task_id(task_id), "reason": reason})


class _RlmOutputApi:
    async def read(self, handle, offset=0, limit=32768):
        return _host_request("output.read", {"handle": handle, "offset": offset, "limit": limit})

    async def search(self, handle, pattern, max_matches=50):
        return _host_request("output.search", {"handle": handle, "pattern": pattern, "max_matches": max_matches})


class _RlmApi:
    def __init__(self):
        self.task = _RlmTaskApi()
        self.output = _RlmOutputApi()

    def state(self):
        return _inventory()


_namespace["rlm"] = _RlmApi()


def _skip_reason(name, value):
    if name.startswith("_") or name in _internal_names:
        return "internal"
    if _secret_name.search(name) or _is_secret(value):
        return "secret-like value"
    if isinstance(value, (types.ModuleType, io.IOBase, socket.socket, subprocess.Popen, types.GeneratorType, types.CoroutineType, asyncio.AbstractEventLoop, threading.Thread)):
        return f"live {type(value).__name__}"
    module = type(value).__module__
    name_lower = type(value).__name__.lower()
    if module.startswith(("torch", "jax", "tensorflow")):
        return f"heavy runtime object {module}.{type(value).__name__}"
    if module == "_thread" or "lock" in name_lower:
        return f"synchronization object {type(value).__name__}"
    return None


class _SnapshotLimitExceeded(Exception):
    pass


class _SnapshotBuffer(io.BytesIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, chunk):
        if self.tell() + len(chunk) > self.limit:
            raise _SnapshotLimitExceeded()
        return super().write(chunk)


def _serializer():
    if _dill is not None:
        return "dill", lambda value, buffer: _dill.dump(value, buffer, recurse=True), _dill.loads
    import pickle
    return "pickle", lambda value, buffer: pickle.dump(value, buffer, protocol=pickle.HIGHEST_PROTOCOL), pickle.loads


def _snapshot(request):
    serializer, dump, _ = _serializer()
    total = 0
    skipped = []
    saved = []
    max_variable = int(request.get("maxVariableBytes", 16 * 1024 * 1024))
    max_total = int(request.get("maxTotalBytes", 64 * 1024 * 1024))
    for name in sorted(_namespace):
        value = _namespace[name]
        reason = _skip_reason(name, value)
        if reason is not None:
            if reason != "internal":
                skipped.append({"name": name, "reason": reason})
            continue
        remaining = max_total - total
        buffer_limit = min(max_variable, remaining)
        buffer = _SnapshotBuffer(buffer_limit)
        try:
            dump(value, buffer)
            blob = buffer.getvalue()
        except _SnapshotLimitExceeded:
            reason = "exceeds per-variable checkpoint limit" if max_variable <= remaining else "exceeds aggregate checkpoint limit"
            skipped.append({"name": name, "reason": reason})
            continue
        except Exception as error:
            skipped.append({"name": name, "reason": f"{type(error).__name__}: {str(error)[:200]}"})
            continue
        digest = hashlib.sha256(blob).hexdigest()
        _send({"id": request["id"], "type": "snapshot.variable", "name": name, "valueType": f"{type(value).__module__}.{type(value).__qualname__}", "serializer": serializer, "sha256": digest, "bytes": len(blob), "data": base64.b64encode(blob).decode("ascii")})
        total += len(blob)
        saved.append(name)
    _send({"id": request["id"], "type": "snapshot.result", "saved": saved, "skipped": skipped, "bytes": total, "serializer": serializer, "cwd": os.getcwd()})


def _restore(request):
    global _access
    _, _, default_loads = _serializer()
    restored = []
    failed = []
    previous_access = _access
    _access = "internal"
    requested_cwd = request.get("cwd")
    if isinstance(requested_cwd, str):
        try:
            os.chdir(requested_cwd)
        except Exception as error:
            failed.append({"name": "<cwd>", "reason": f"{type(error).__name__}: {str(error)[:200]}"})
    for item in request.get("variables", []):
        name = item.get("name")
        if not isinstance(name, str) or name.startswith("_") or name == "rlm":
            continue
        try:
            blob = base64.b64decode(item["data"])
            if hashlib.sha256(blob).hexdigest() != item["sha256"]:
                raise ValueError("checkpoint hash mismatch")
            if item.get("serializer") == "dill":
                if _dill is None:
                    raise RuntimeError("dill checkpoint cannot be restored without dill")
                value = _dill.loads(blob)
            else:
                value = default_loads(blob)
            _namespace[name] = value
            restored.append(name)
        except Exception as error:
            failed.append({"name": name, "reason": f"{type(error).__name__}: {str(error)[:200]}"})
    _access = previous_access
    _send({"id": request["id"], "type": "restore.result", "restored": sorted(restored), "failed": failed})


def _handle_execute(request):
    global _access, _active_request_id, _effects
    request_id = request["id"]
    _active_request_id = request_id
    _access = request.get("access", "work")
    _effects = {"filesWritten": set(), "filesDeleted": set(), "subprocessStarted": False}
    before_threads = {thread.ident for thread in threading.enumerate()}
    ok = True
    error = None
    trace = None
    try:
        _execute(request.get("code", ""), request_id)
    except BaseException as exc:
        ok = False
        error = f"{type(exc).__name__}: {exc}"
        trace = traceback.format_exc()
        traceback.print_exc()
    finally:
        _access = "closed"
    lingering = [thread.name for thread in threading.enumerate() if thread.ident not in before_threads and thread.is_alive()]
    effects = {"filesWritten": sorted(_effects["filesWritten"]), "filesDeleted": sorted(_effects["filesDeleted"]), "subprocessStarted": _effects["subprocessStarted"], "lingeringThreads": lingering}
    _effects = None
    _active_request_id = None
    sys.stdout.flush()
    sys.stderr.flush()
    _send({"id": request_id, "type": "execute.result", "ok": ok, "error": error, "traceback": trace, "effects": effects, "state": _inventory()})


_internal_names = set(_namespace)

for _raw in _control:
    if not _raw.strip():
        continue
    _request = {}
    try:
        _request = json.loads(_raw.decode("utf-8"))
        _operation = _request.get("operation")
        if _operation == "execute":
            _handle_execute(_request)
        elif _operation == "snapshot":
            _snapshot(_request)
        elif _operation == "restore":
            _restore(_request)
        elif _operation == "state":
            _send({"id": _request["id"], "type": "state.result", "variables": _inventory()})
        elif _operation == "shutdown":
            _send({"id": _request["id"], "type": "shutdown.result"})
            break
        else:
            _send({"id": _request.get("id"), "type": "protocol.error", "error": "unknown operation"})
    except BaseException as _error:
        _send({"id": _request.get("id") if isinstance(_request, dict) else None, "type": "protocol.error", "error": f"{type(_error).__name__}: {_error}"})
`;
