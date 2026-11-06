"""Re-render an older checkpoint against the new run's exact test images.

This compares complete pipelines (including training resolution), not an
ablation of one algorithm setting. No test result feeds back into training.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import torch

from .camera import frame_camera, validate_split
from .experiment import camera_tensors, load_image, write_json
from .metrics import image_metrics
from .renderer import GaussianModel


def pose_signature(frame):
    camera = frame_camera(frame, np.zeros(3, np.float32), 1.0)
    calibration = camera.copy()
    return np.concatenate([camera["rotation"].flatten(), camera["translation"],
        [calibration[key]/frame["width"] for key in ["fx", "cx"]],
        [calibration[key]/frame["height"] for key in ["fy", "cy"]]])


def match_cameras(previous, current):
    if len(previous) != len(current):
        raise ValueError("Comparison requires identical train/test camera sets")
    matches = []
    used = set()
    for frame in current:
        candidates = [i for i, old in enumerate(previous) if i not in used and
                      np.allclose(pose_signature(old), pose_signature(frame), atol=1e-5, rtol=0)]
        if len(candidates) != 1:
            raise ValueError("Comparison requires identical poses and normalized calibration")
        used.add(candidates[0]); matches.append(previous[candidates[0]])
    return matches


def compare(baseline: Path, candidate: Path):
    torch.set_num_threads(4)
    device = torch.device("cuda:0")
    torch.cuda.set_per_process_memory_fraction(0.65, device)
    read = lambda root, name: json.loads((root/name).read_text(encoding="utf-8"))
    old_report, report = read(baseline, "report.json"), read(candidate, "report.json")
    if old_report["source_identity"] != report["source_identity"]:
        raise ValueError("Cannot compare different source point clouds")
    old_manifest, manifest = read(baseline, "manifest.json"), read(candidate, "manifest.json")
    old_train, old_test = validate_split(old_manifest)
    train, test = validate_split(manifest)
    match_cameras(old_train, train)
    matched = match_cameras(old_test, test)
    old_config, config = read(baseline, "config.json"), read(candidate, "config.json")
    if old_config["background"] != config["background"]:
        raise ValueError("Cannot compare different background colors")
    checkpoint = torch.load(baseline/"checkpoint.pt", map_location=device, weights_only=False)
    state = checkpoint["model"]
    model = GaussianModel(state["means"], state["colors"].sigmoid(), state["log_scales"].exp())
    model.load_state_dict(state)
    origin, scale = np.array(checkpoint["origin"], np.float32), checkpoint["scene_scale"]
    background = torch.tensor(config["background"], device=device)
    views = []
    with torch.no_grad():
        for old, frame in zip(matched, test):
            camera = camera_tensors(frame, origin, scale, device)
            reference = load_image(Path(config["storage"]).resolve(), frame, device)
            prediction = model.render(camera, background)
            name = f"baseline-{frame['frameId']}-prediction.png"
            Image.fromarray((prediction.cpu().numpy()*255).round().astype(np.uint8)).save(candidate/name)
            views.append({"frame_id": frame["frameId"], "baseline_frame_id": old["frameId"],
                          "baseline_image": name, **image_metrics(prediction, reference, background)})
    quality = {}
    for key in ["psnr", "ssim", "foreground_psnr", "foreground_fraction"]:
        values = [view[key] for view in views if view[key] is not None]
        quality[key] = float(np.mean(values)) if values else None
    result = {"baseline_job_id": baseline.name, "candidate_job_id": candidate.name,
              "scope": "complete_pipeline_same_test_cameras_same_reference_images_same_output_resolution",
              "width": report["width"], "height": report["height"],
              "baseline_training_resolution": [old_report["width"], old_report["height"]],
              "candidate_training_resolution": [report["width"], report["height"]],
              "baseline_quality": quality, "candidate_quality": report["quality"],
              "baseline_gaussians": old_report["gaussians"], "candidate_gaussians": report["gaussians"],
              "baseline_steps": old_report["steps"], "candidate_steps": report["steps"],
              "views": views, "image": "quality-comparison.png"}
    width, height = report["width"], report["height"]
    canvas = Image.new("RGB", (width*3, height+32), "#101820")
    draw = ImageDraw.Draw(canvas)
    names = [views[0]["baseline_image"], report["views"][0]["prediction_image"], report["views"][0]["reference_image"]]
    for i, (name, label) in enumerate(zip(names, ["Previous model / re-rendered at same resolution", "Detail model / native render", "Held-out reference"])):
        with Image.open(candidate/name) as image: canvas.paste(image, (i*width, 32))
        draw.text((i*width+8, 10), label, fill="white")
    canvas.save(candidate/result["image"])
    write_json(candidate/"baseline-comparison.json", result)
    report["previous_run_comparison"] = result
    write_json(candidate/"report.json", report)
    print(json.dumps({key: value for key, value in result.items() if key != "views"}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    args = parser.parse_args()
    compare(args.baseline, args.candidate)
