"""Versioned training settings; kept free of torch for the lightweight API."""

PROFILES = {
    "baseline": {"version": 1, "voxel_size_m": 2.0, "scale_factor": 0.55,
                 "random_tiles": 2, "foreground_tiles": 6, "position_lr": 0.00015,
                 "max_scale_m": 12.0},
    "detail": {"version": 1, "voxel_size_m": 0.6, "scale_factor": 0.55,
               "random_tiles": 8, "foreground_tiles": 24, "position_lr": 0.00005,
               "max_scale_m": 2.0},
}


def training_profile(config: dict) -> dict:
    return {"name": config.get("quality_preset", "baseline"),
            **PROFILES[config.get("quality_preset", "baseline")]}
