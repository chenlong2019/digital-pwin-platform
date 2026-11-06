"""Lightweight source identity, shared by the API and training worker."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def source_identity(asset_root: Path) -> dict:
    data = (asset_root / "index.json").read_bytes()
    index = json.loads(data)
    return {
        "index_sha256": hashlib.sha256(data).hexdigest(),
        "overview_sha256": index["overview"]["sha256"],
        "overview_level": index["overview"]["level"],
    }
