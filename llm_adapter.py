# llm_adapter.py
"""
SentIQ — Unified LLM Gateway (Production)

Supports:
- RecruiterIQ (evaluation, scoring)
- Resume & Portfolio Builder (generation)

Providers:
- Primary: Google Gemini
- Failover: Groq (Llama 3)

Design goals:
- Strict JSON where required
- Task-aware routing
- Backward compatibility
"""

import os
import time
import json
import shelve
import hashlib
import threading
import logging
import importlib
from typing import Optional

# ------------------------------
# Optional SDK imports
# ------------------------------
try:
    import groq
except Exception:
    groq = None

GENAI_MODULE = None
GENAI_CLIENT_FACTORY = None

for name in ["google.generativeai", "google.genai", "genai"]:
    try:
        spec = importlib.util.find_spec(name)
        if spec:
            GENAI_MODULE = importlib.import_module(name)
            break
    except Exception:
        pass

# ------------------------------
# Environment
# ------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, ".env"))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")

_CACHE_FILE_ENV = os.getenv("SENTIQ_CACHE_FILE", "sentiq_cache.db")
CACHE_FILE = _CACHE_FILE_ENV if os.path.isabs(_CACHE_FILE_ENV) else os.path.join(BASE_DIR, _CACHE_FILE_ENV)
RPM = int(os.getenv("SENTIQ_RPM", "120"))

# ------------------------------
# Logger
# ------------------------------
logger = logging.getLogger("sentiq.llm")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

# ------------------------------
# Rate Limiter
# ------------------------------
class TokenBucket:
    def __init__(self, rpm):
        self.capacity = rpm
        self.tokens = rpm
        self.rate = rpm / 60.0
        self.last = time.time()
        self.lock = threading.Lock()

    def consume(self, n=1):
        with self.lock:
            now = time.time()
            delta = now - self.last
            self.last = now
            self.tokens = min(self.capacity, self.tokens + delta * self.rate)
            if self.tokens >= n:
                self.tokens -= n
                return True
            return False

bucket = TokenBucket(RPM)

# ------------------------------
# Cache helpers
# ------------------------------
def _cache_key(prompt: str, task: str, model: str):
    h = hashlib.sha256()
    h.update(f"{task}|{model}|{prompt}".encode())
    return h.hexdigest()

# ------------------------------
# Task policies
# ------------------------------
# Load canonical task names from shared registry (single source of truth).
# Both Python (llm_adapter.py) and TypeScript (PromptBuilders.ts) consume this file.
_REGISTRY_PATH = os.path.join(BASE_DIR, "task_registry.json")
try:
    with open(_REGISTRY_PATH, "r", encoding="utf-8") as _f:
        _registry = json.load(_f)
    STRICT_JSON_TASKS = set(_registry.get("strict_json_tasks", []))
except Exception as _e:
    logger.error("Failed to load task_registry.json: %s — falling back to empty set.", _e)
    STRICT_JSON_TASKS = set()

# ------------------------------
# Simulation (safe dev mode)
# ------------------------------
def simulated_response(prompt: str, task: str) -> str:
    if task in STRICT_JSON_TASKS:
        return '{"status":"simulated","task":"' + task + '"}'
    return "SIMULATED RESPONSE"

# ------------------------------
# Gemini invocation
# ------------------------------
def _call_gemini(prompt: str, model: Optional[str] = None) -> str:
    if not GENAI_MODULE:
        raise RuntimeError("Gemini SDK not installed")
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY missing")

    if not bucket.consume():
        raise RuntimeError("Rate limit exceeded")

    if hasattr(GENAI_MODULE, "configure"):
        GENAI_MODULE.configure(api_key=GEMINI_API_KEY)

    model_obj = GENAI_MODULE.GenerativeModel(model or GEMINI_MODEL)
    resp = model_obj.generate_content(prompt)
    return getattr(resp, "text", str(resp))

# ------------------------------
# Groq invocation (JSON-safe)
# ------------------------------
def _call_groq(prompt: str, model: Optional[str] = None) -> str:
    if not groq or not GROQ_API_KEY:
        raise RuntimeError("Groq not configured")

    if not bucket.consume():
        raise RuntimeError("Rate limit exceeded")

    client = groq.Groq(api_key=GROQ_API_KEY)
    completion = client.chat.completions.create(
        model=model or GROQ_MODEL,
        messages=[
            {"role": "system", "content": "You must respond with valid JSON only."},
            {"role": "user", "content": prompt}
        ],
        temperature=0.3,
        response_format={"type": "json_object"}
    )
    return completion.choices[0].message.content.strip()

# ------------------------------
# Router
# ------------------------------
def call_llm_router(
    prompt: str,
    task: str = "general",
    use_simulation: bool = False,
    prefer: Optional[str] = None,
    model_override: Optional[str] = None
) -> str:

    if use_simulation:
        return simulated_response(prompt, task)

    model = model_override or (GEMINI_MODEL if prefer != "groq" else GROQ_MODEL)
    key = _cache_key(prompt, task, model)

    # Cache
    try:
        with shelve.open(CACHE_FILE) as db:
            if key in db:
                return db[key]
    except Exception:
        pass

    # Enforce JSON if needed
    if task in STRICT_JSON_TASKS:
        prompt = (
            "SYSTEM: Respond ONLY with valid JSON. "
            "No markdown. No explanations.\n\n" + prompt
        )

    providers = ["gemini", "groq"] if prefer != "groq" else ["groq", "gemini"]
    last_error = None

    for p in providers:
        try:
            if p == "gemini":
                result = _call_gemini(prompt, model_override)
            else:
                result = _call_groq(prompt, model_override)

            with shelve.open(CACHE_FILE) as db:
                db[key] = result
            return result

        except Exception as e:
            last_error = e
            logger.warning("Provider %s failed: %s", p, e)

    logger.error("All providers failed: %s", last_error)
    return json.dumps({"error": "all_providers_failed", "detail": str(last_error)})

# ------------------------------
# Backward-compatible API
# ------------------------------
def call_llm(
    prompt: str,
    category: str = "general",
    use_simulation: bool = False,
    model_override: Optional[str] = None
) -> str:
    return call_llm_router(
        prompt=prompt,
        task=category,
        use_simulation=use_simulation,
        model_override=model_override
    )
