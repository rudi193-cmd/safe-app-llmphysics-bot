"""SAFE Framework Integration for LLMPhysics Bot."""

import os as _os

_WILLOW_URL = _os.environ.get("WILLOW_URL", "http://localhost:8420")
_APP_ID = "safe-app-llmphysics-bot"


def get_manifest():
    import json
    from pathlib import Path
    manifest_path = Path(__file__).parent / "safe-app-manifest.json"
    return json.loads(manifest_path.read_text())


def status():
    """Health check for the Willow Pigeon bus."""
    try:
        import requests as _r
        r = _r.get(f"{_WILLOW_URL}/api/pigeon/status", timeout=5)
        data = r.json()
        return {
            "app_id": _APP_ID,
            "status": "ok",
            "willow_reachable": True,
            "willow_status": data.get("status"),
        }
    except Exception:
        return {
            "app_id": _APP_ID,
            "status": "ok",
            "willow_reachable": False,
        }
