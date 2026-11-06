from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import time
import traceback
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import torch

from .camera import frame_camera, validate_split
from .metrics import image_metrics, ssim
from .renderer import GaussianModel
from .source import source_identity
from .profiles import training_profile
from .surface import initialize_surfaces

BACKEND = "torch-3dgs-reference"


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def point_prior(asset_root: Path, count: int, seed: int, voxel_size: float = 2.0) -> tuple[np.ndarray, np.ndarray, float]:
    index = json.loads((asset_root / "index.json").read_text(encoding="utf-8"))
    raw = gzip.decompress((asset_root / index["overview"]["file"]).read_bytes())
    if hashlib.sha256(raw).hexdigest() != index["overview"]["sha256"]:
        raise ValueError("Campus point initialization checksum mismatch")
    dtype = np.dtype([("xyz", "<i2", (3,)), ("rgb", "u1", (3,))])
    positions, colors = [], []
    origin = np.array(index["origin"])
    for tile in index["tiles"]:
        ref = next(lod for lod in tile[6] if lod[0] == index["overview"]["level"])
        data = np.frombuffer(raw, dtype=dtype, count=ref[3], offset=tile[7])
        xyz = np.array(tile[2]) + data["xyz"].astype(np.float32)*tile[3] - origin
        xyz[:, 2] *= -1
        positions.append(xyz.astype(np.float32)); colors.append(data["rgb"].astype(np.float32)/255)
    positions, colors = np.concatenate(positions), np.concatenate(colors)
    _, inverse, counts = np.unique(np.floor(positions/voxel_size).astype(np.int32), axis=0,
                                   return_inverse=True, return_counts=True)
    means = np.zeros((len(counts), 3), np.float64)
    rgb = np.zeros_like(means)
    np.add.at(means, inverse, positions); np.add.at(rgb, inverse, colors)
    means /= counts[:, None]; rgb /= counts[:, None]
    rng = np.random.default_rng(seed)
    keep = rng.choice(len(means), min(count, len(means)), replace=False)
    return means[keep].astype(np.float32), rgb[keep].astype(np.float32), voxel_size


def camera_tensors(frame: dict, origin, scale, device) -> dict:
    camera = frame_camera(frame, origin, scale)
    for key in ("rotation", "translation"):
        camera[key] = torch.tensor(camera[key], device=device)
    return camera


def load_image(storage: Path, frame: dict, device) -> torch.Tensor:
    path = (storage / frame["imageUri"]).resolve()
    if not path.is_relative_to(storage):
        raise ValueError("Dataset image escapes storage")
    if frame.get("contentHash") and hashlib.sha256(path.read_bytes()).hexdigest() != frame["contentHash"]:
        raise ValueError("Dataset image checksum mismatch")
    image = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)/255
    if image.shape[:2] != (frame["height"], frame["width"]):
        raise ValueError("Image and calibration dimensions disagree")
    return torch.tensor(image, device=device)


def export_ply(path: Path, model: GaussianModel, origin: np.ndarray, scene_scale: float):
    means = model.means.detach().cpu().numpy()*scene_scale + origin
    colors = (model.colors.sigmoid().detach().cpu().numpy()-0.5)/0.28209479177387814
    scales = model.log_scales.detach().cpu().numpy() + math.log(scene_scale)
    rotations = torch.nn.functional.normalize(model.quaternions.detach(), dim=-1).cpu().numpy()
    opacity = model.opacity.detach().cpu().numpy()[:, None]
    values = np.column_stack([means, np.zeros_like(means), colors, opacity, scales, rotations]).astype("<f4")
    properties = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {len(values)}\n"
    header += "".join(f"property float {name}\n" for name in properties) + "end_header\n"
    path.write_bytes(header.encode("ascii") + values.tobytes())


def synchronize(device):
    if device.type == "cuda": torch.cuda.synchronize(device)


def run(config_path: Path):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output = config_path.parent
    progress_path = output / "progress.json"
    def progress(stage, step=0, **extra):
        write_json(progress_path, {"status": "running", "stage": stage, "step": step,
                                  "steps": config["steps"], "updated_at": time.time(), "pid": os.getpid(), **extra})
    try:
        progress("preparing")
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        seed = config["seed"]
        torch.manual_seed(seed); np.random.seed(seed)
        device = torch.device(config.get("device", "cuda:0" if torch.cuda.is_available() else "cpu"))
        if device.type != "cuda" and not config.get("allow_cpu", False):
            raise RuntimeError("CUDA GPU unavailable. Install a CUDA torch build or explicitly allow CPU.")
        if device.type == "cuda": torch.cuda.set_per_process_memory_fraction(0.65, device)
        storage = Path(config["storage"]).resolve()
        manifest_path = output / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        train_frames, test_frames = validate_split(manifest)
        manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        identity = source_identity(Path(config["assets"]))
        if identity != config["source_identity"]:
            raise ValueError("Source point cloud changed after experiment submission")
        # Test images are loaded only during final evaluation, never by training.
        profile = config.get("training_profile", training_profile(config))
        origin = np.array(profile.get("scene_origin", [0, 25, -105]), np.float32)
        scene_scale = profile.get("scene_scale", 150.0)
        means, colors, voxel_size = point_prior(Path(config["assets"]), config["gaussians"], seed, profile["voxel_size_m"])
        count = len(means)
        world_means = means.copy()
        means = torch.tensor((means-origin)/scene_scale, device=device)
        model = GaussianModel(means, torch.tensor(colors, device=device),
                              torch.full((count, 3), voxel_size*profile["scale_factor"]/scene_scale, device=device))
        surface_initialization = (initialize_surfaces(model, world_means, voxel_size, scene_scale)
                                  if profile.get("surface_initialization") else None)
        initial_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        background = torch.tensor(config["background"], device=device)
        optimizer = torch.optim.Adam([
            {"params": [model.means], "lr": profile["position_lr"]},
            {"params": [model.colors], "lr": profile.get("color_lr", 0.025)},
            {"params": [model.log_scales], "lr": profile.get("scale_lr", 0.006)},
            {"params": [model.quaternions], "lr": profile.get("rotation_lr", 0.002)},
            {"params": [model.opacity], "lr": profile.get("opacity_lr", 0.025)},
        ], eps=1e-8)
        checkpoint_path = output / "checkpoint.pt"
        start_step, history, previous_seconds = 0, [], 0.0
        if checkpoint_path.is_file() and config.get("resume", False):
            checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
            if checkpoint["manifest_hash"] != manifest_hash:
                raise ValueError("Resume requires exactly the same sealed dataset")
            if checkpoint.get("source_identity") != identity:
                raise ValueError("Resume requires exactly the same source point cloud")
            saved_config = checkpoint["config"]
            if profile != saved_config.get("training_profile", training_profile(saved_config)):
                raise ValueError("Resume requires exactly the same training profile")
            model.load_state_dict(checkpoint["model"]); optimizer.load_state_dict(checkpoint["optimizer"])
            initial_state = checkpoint["initial_state"]
            start_step, history = checkpoint["step"], checkpoint["history"]
            previous_seconds = checkpoint.get("training_seconds", 0.0)
            if config["steps"] <= start_step:
                raise ValueError("Resume target steps must exceed the saved checkpoint step")
            torch.set_rng_state(checkpoint["rng"].cpu())
            if device.type == "cuda": torch.cuda.set_rng_state(checkpoint["cuda_rng"].cpu())
        cameras = [camera_tensors(frame, origin, scene_scale, device) for frame in train_frames]
        reference_device = torch.device("cpu") if profile.get("microbatch_tiles") else device
        references = [load_image(storage, frame, reference_device) for frame in train_frames]
        width, height = train_frames[0]["width"], train_frames[0]["height"]
        if width % 16 or height % 16:
            raise ValueError("Reference experiment resolution must be divisible by 16")
        rows, columns = height//16, width//16
        patches = [image.reshape(rows, 16, columns, 16, 3).permute(0, 2, 1, 3, 4).reshape(rows*columns, 256, 3)
                   for image in references]
        foreground_tiles = [torch.nonzero((patch-background.to(reference_device)).abs().amax(-1).mean(-1) > 0.03)
                            .flatten().to(device) for patch in patches]
        del references
        synchronize(device)
        started = time.perf_counter()

        def save_checkpoint(completed_step):
            synchronize(device)
            temporary = checkpoint_path.with_suffix(".tmp")
            torch.save({"model": model.state_dict(), "initial_state": initial_state, "optimizer": optimizer.state_dict(),
                        "step": completed_step, "history": history, "manifest_hash": manifest_hash,
                        "source_identity": identity, "training_seconds": previous_seconds+time.perf_counter()-started,
                        "rng": torch.get_rng_state(), "cuda_rng": torch.cuda.get_rng_state() if device.type == "cuda" else None,
                        "origin": origin.tolist(), "scene_scale": scene_scale, "config": config}, temporary)
            os.replace(temporary, checkpoint_path)

        for step in range(start_step, config["steps"]):
            if (output / "cancel").exists():
                save_checkpoint(step)
                write_json(progress_path, {"status": "failed", "stage": "stopped", "cancelled": True,
                           "step": step, "steps": config["steps"], "can_resume": True,
                           "updated_at": time.time(), "pid": os.getpid(),
                           "error": "实验已停止，当前进度已保存，可从检查点恢复"})
                return
            view = int(torch.randint(len(cameras), (1,)).item())
            selected = torch.randint(rows*columns, (profile["random_tiles"],), device=device)
            occupied = foreground_tiles[view]
            if len(occupied): selected = torch.cat([selected, occupied[torch.randint(len(occupied), (profile["foreground_tiles"],), device=device)]])
            optimizer.zero_grad(set_to_none=True)
            loss_value, l1_value = 0.0, 0.0
            # Exact weighted gradient accumulation, without dropping visible splats.
            for batch in selected.split(profile.get("microbatch_tiles", len(selected))):
                predicted = model.render_tiles(model.project(cameras[view]), cameras[view], batch, background)
                reference = patches[view][batch.to(reference_device)].to(device)
                l1 = (predicted-reference).abs().mean()
                score = ssim(predicted.reshape(-1, 16, 16, 3).permute(0, 3, 1, 2),
                             reference.reshape(-1, 16, 16, 3).permute(0, 3, 1, 2))
                loss = 0.8*l1 + 0.2*(1-score)
                if not torch.isfinite(loss): raise RuntimeError("Non-finite Gaussian training loss")
                weight = len(batch)/len(selected)
                (loss*weight).backward()
                loss_value += float(loss.detach())*weight
                l1_value += float(l1.detach())*weight
            torch.nn.utils.clip_grad_norm_(model.parameters(), 10)
            optimizer.step()
            with torch.no_grad(): model.log_scales.clamp_(math.log(profile.get("min_scale_m", 0.05)/scene_scale),
                                                        math.log(profile["max_scale_m"]/scene_scale))
            if (step+1) % 20 == 0 or step+1 == config["steps"]:
                row = {"step": step+1, "loss": loss_value, "l1": l1_value}
                history.append(row)
                progress("training", step+1, loss=row["loss"], elapsed_seconds=previous_seconds+time.perf_counter()-started,
                         resumed_from_step=start_step)
                print(json.dumps(row), flush=True)
            if (step+1) % 100 == 0 or step+1 == config["steps"]:
                save_checkpoint(step+1)
        synchronize(device)
        training_seconds = previous_seconds+time.perf_counter()-started
        progress("evaluating", config["steps"])
        initial = GaussianModel(means.detach().clone(), torch.tensor(colors, device=device),
                                torch.full((count, 3), voxel_size*profile["scale_factor"]/scene_scale, device=device))
        initial.load_state_dict(initial_state)
        metrics, benchmark_cameras = [], []
        with torch.no_grad():
            for frame in test_frames:
                camera = camera_tensors(frame, origin, scene_scale, device)
                reference = load_image(storage, frame, device)
                prediction = model.render(camera, background)
                baseline = initial.render(camera, background)
                row = {"frame_id": frame["frameId"], **image_metrics(prediction, reference, background),
                       "initial": image_metrics(baseline, reference, background)}
                prefix = frame["frameId"]
                for name, tensor in [("reference", reference), ("prediction", prediction),
                                     ("difference", (prediction-reference).abs()*3)]:
                    filename = f"{prefix}-{name}.png"
                    Image.fromarray((tensor.clamp(0, 1).cpu().numpy()*255).round().astype(np.uint8)).save(output/filename)
                    row[name+"_image"] = filename
                metrics.append(row); benchmark_cameras.append(camera)
            # Measure rendering only. Warm-up and synchronize CUDA on both ends;
            # PNG encoding, upload, loading and quality metrics are excluded.
            for i in range(3): model.render(benchmark_cameras[i % len(benchmark_cameras)], background)
            synchronize(device)
            if device.type == "cuda": torch.cuda.reset_peak_memory_stats(device)
            timings = []
            for i in range(20):
                synchronize(device); tick = time.perf_counter()
                model.render(benchmark_cameras[i % len(benchmark_cameras)], background)
                synchronize(device); timings.append((time.perf_counter()-tick)*1000)
        def mean(key):
            values = [row[key] for row in metrics if row[key] is not None]
            return float(np.mean(values)) if values else None
        report = {"schema_version": 1, "backend": BACKEND, "dataset_id": manifest["datasetId"],
                  "manifest_sha256": manifest_hash, "source_identity": identity,
                  "source_verified_at_capture": config.get("source_verified_at_capture", False),
                  "seed": seed, "steps": config["steps"], "resumed_from_step": start_step,
                  "quality_preset": profile["name"], "training_profile": profile,
                  "scene_id": config.get("scene_id", manifest.get("sceneId")),
                  "surface_initialization": surface_initialization,
                  "normalization": {"origin": origin.tolist(), "scene_scale": scene_scale},
                  "capture_representation": manifest.get("metadata", {}).get("pointAppearance", "legacy_lit_point_discs"),
                  "train_frames": [f["frameId"] for f in train_frames], "test_frames": [f["frameId"] for f in test_frames],
                  "initialization": "simulation_point_cloud_geometry_color_prior", "gaussians": count,
                  "width": width, "height": height, "training_seconds": training_seconds,
                  "device": torch.cuda.get_device_name(device) if device.type == "cuda" else "CPU",
                  "torch_version": torch.__version__, "cuda_version": torch.version.cuda,
                  "quality": {key: mean(key) for key in ["psnr", "ssim", "foreground_psnr", "foreground_fraction"]},
                  "initial_quality": {key: float(np.mean([m["initial"][key] for m in metrics])) for key in ["psnr", "ssim"]},
                  "performance": {"fps": 1000/float(np.mean(timings)), "mean_ms": float(np.mean(timings)),
                                  "p50_ms": float(np.percentile(timings, 50)), "p95_ms": float(np.percentile(timings, 95)),
                                  "samples": len(timings), "warmup": 3, "scope": "renderer_only_synchronized",
                                  "peak_allocated_mb": torch.cuda.max_memory_allocated(device)/1024**2 if device.type == "cuda" else None},
                  "views": metrics, "training_history": history,
                  "limitations": ["Synthetic point-cloud images; not real-camera quality validation.",
                                  "Known camera poses and source geometry/color initialization; not RGB-only reconstruction.",
                                  "Fixed Gaussian count, degree-0 color; no adaptive densification.",
                                  "FPS is this PyTorch reference backend, not a CUDA gsplat or browser benchmark."]}
        export_ply(output/"model.ply", model, origin, scene_scale)
        write_json(output/"report.json", report)
        panels = [Image.open(output/metrics[0][key]) for key in ["reference_image", "prediction_image", "difference_image"]]
        comparison = Image.new("RGB", (width*3, height+28), "#101820")
        draw = ImageDraw.Draw(comparison)
        for i, (panel, label) in enumerate(zip(panels, ["Held-out reference", "Trained 3D Gaussian", "Absolute error x3"])):
            comparison.paste(panel, (width*i, 28)); draw.text((width*i+8, 8), label, fill="white")
        comparison.save(output/"comparison.png")
        write_json(progress_path, {"status": "completed", "stage": "completed", "step": config["steps"],
                                   "steps": config["steps"], "updated_at": time.time(), "report": "report.json", "pid": os.getpid()})
    except Exception as error:
        write_json(progress_path, {"status": "failed", "stage": "failed", "error": str(error),
                                   "updated_at": time.time(), "pid": os.getpid()})
        traceback.print_exc()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    run(parser.parse_args().config)
