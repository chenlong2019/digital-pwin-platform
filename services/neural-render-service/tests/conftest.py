from pathlib import Path
import sys
import base64
import io
import time

import pytest
from PIL import Image
from fastapi.testclient import TestClient


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def png_url():
    def make(width=16, height=12, color=0):
        output = io.BytesIO()
        Image.new("RGB", (width, height), (color % 256, 90, 140)).save(output, format="PNG")
        return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    return make


@pytest.fixture
def frame_factory(png_url):
    def make(frame_id="frame-1", index=0):
        return {
            "frameId": frame_id, "imageDataUrl": png_url(color=index), "width": 16, "height": 12,
            "simulationTime": index + 1, "capturedAt": f"2026-11-06T00:00:{index:02d}Z",
            "cameraPose": {"positionM": {"x": index, "y": 6, "z": 0}, "quaternionXyzw": {"x": 0, "y": 0, "z": 0, "w": 1}},
            "cameraIntrinsics": {"width": 16, "height": 12, "fx": 10, "fy": 10, "cx": 8, "cy": 6},
        }
    return make


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", "")
    from app import main
    from app.store import PersistentStore
    from app.capture_store import CaptureTaskStore

    store = PersistentStore(str(tmp_path))
    now = [time.time()]
    queue = CaptureTaskStore(store, clock=lambda: now[0])
    monkeypatch.setattr(main, "store", store)
    monkeypatch.setattr(main, "capture_store", queue)
    with TestClient(main.app) as client:
        yield {"client": client, "store": store, "queue": queue, "now": now, "main": main}
