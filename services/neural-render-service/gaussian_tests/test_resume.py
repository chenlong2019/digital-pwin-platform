"""Real optimizer/checkpoint round trip on a tiny CPU scene, including surfels."""
import gzip
import hashlib
import json

import numpy as np
from PIL import Image
import torch

from app.gaussian.experiment import run
from app.gaussian.profiles import training_profile
from app.gaussian.source import source_identity


def test_surface_training_resume_restores_parameters_adam_and_rng_exactly(tmp_path):
    assets, storage = tmp_path/"assets", tmp_path/"storage"
    assets.mkdir(); storage.mkdir()
    samples = np.zeros(81, dtype=[("xyz", "<i2", (3,)), ("rgb", "u1", (3,))])
    x, y = np.meshgrid(np.arange(9)*5-20, np.arange(9)*5-20)
    samples["xyz"] = np.column_stack([x.ravel(), y.ravel(), np.full(81, 300)])
    samples["rgb"] = [160, 190, 210]
    raw = samples.tobytes()
    (assets/"overview.bin.gz").write_bytes(gzip.compress(raw))
    (assets/"index.json").write_text(json.dumps({"origin": [0, 0, 0],
        "overview": {"file": "overview.bin.gz", "level": 0, "sha256": hashlib.sha256(raw).hexdigest()},
        "tiles": [[1, 1, [0, 0, 0], .01, [-.2, -.2, 3], [.2, .2, 3], [[0, 0, 0, 81, .05]], 0]]}))
    image = np.zeros((64, 64, 3), np.uint8); image[24:40, 24:40] = [160, 190, 210]
    Image.fromarray(image).save(storage/"frame.png")
    frames = [{"frameId": f"view-{i}", "width": 64, "height": 64, "imageUri": "frame.png",
        "metadata": {"split": "train" if i < 8 else "test"},
        "cameraPose": {"positionM": {"x": (i-4)*.01, "y": 0, "z": 0},
            "quaternionXyzw": {"x": 0, "y": 0, "z": 0, "w": 1}},
        "cameraIntrinsics": {"width": 64, "height": 64, "fx": 50, "fy": 50, "cx": 32, "cy": 32}}
        for i in range(10)]
    manifest = {"datasetId": "fixture", "frames": frames}
    config = {"allow_cpu": True, "device": "cpu", "seed": 17, "steps": 3, "gaussians": 200,
        "storage": str(storage.resolve()), "assets": str(assets.resolve()), "background": [0, 0, 0],
        "source_identity": source_identity(assets), "quality_preset": "building"}
    config["training_profile"] = {**training_profile(config), "voxel_size_m": .05,
        "scene_origin": [0, 0, 0], "scene_scale": 1, "random_tiles": 1, "foreground_tiles": 3,
        "microbatch_tiles": 3}
    def execute(name, settings):
        directory = tmp_path/name
        directory.mkdir(exist_ok=True)
        (directory/"manifest.json").write_text(json.dumps(manifest))
        path = directory/"config.json"
        path.write_text(json.dumps(settings))
        run(path)
        return torch.load(directory/"checkpoint.pt", weights_only=False, map_location="cpu")
    execute("resumed", config)
    resumed = execute("resumed", {**config, "steps": 7, "resume": True})
    whole = execute("whole", {**config, "steps": 7})
    for key in whole["model"]:
        torch.testing.assert_close(resumed["model"][key], whole["model"][key], rtol=0, atol=0)
    for parameter, state in whole["optimizer"]["state"].items():
        for key, value in state.items():
            torch.testing.assert_close(resumed["optimizer"]["state"][parameter][key], value, rtol=0, atol=0)
    assert torch.equal(resumed["rng"], whole["rng"])
