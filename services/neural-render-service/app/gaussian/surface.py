"""Local PCA surfels, computed from the geometry prior without image/test access."""
import numpy as np
import torch


def initialize_surfaces(model, positions: np.ndarray, voxel_size: float, scene_scale: float):
    # Aggregate local covariance in 3-voxel cells. Avoid a quadratic distance matrix
    # or a SciPy dependency; all operations are bounded by the number of points.
    _, group, counts = np.unique(np.floor(positions / (3 * voxel_size)).astype(np.int32),
                                 axis=0, return_inverse=True, return_counts=True)
    centers = np.zeros((len(counts), 3), np.float64)
    np.add.at(centers, group, positions)
    centers /= counts[:, None]
    delta = positions - centers[group]
    covariance = np.zeros((len(counts), 3, 3), np.float64)
    np.add.at(covariance, group, delta[:, :, None] * delta[:, None, :])
    covariance /= counts[:, None, None]
    values, axes = np.linalg.eigh(covariance)
    reliable = (counts >= 5) & (values[:, 1] > voxel_size**2 * .02)
    reliable &= values[:, 0] < values[:, 1] * .3
    normal = axes[group, :, 0]
    normal *= np.where(normal[:, 2:3] < 0, -1, 1)
    rotation = np.column_stack([1 + normal[:, 2], -normal[:, 1], normal[:, 0], np.zeros(len(normal))])
    rotation /= np.linalg.norm(rotation, axis=1, keepdims=True)
    selected = reliable[group]
    device = model.means.device
    with torch.no_grad():
        mask = torch.tensor(selected, device=device)
        model.quaternions[mask] = torch.tensor(rotation[selected], dtype=torch.float32, device=device)
        # Local Z is the surface normal; two tangential axes retain coverage.
        model.log_scales[mask, 2] = np.log(max(.015, voxel_size * .10) / scene_scale)
    return {"method": "local_voxel_pca", "neighborhood_m": 3 * voxel_size,
            "flattened_gaussians": int(selected.sum()), "normal_sigma_m": max(.015, voxel_size * .10)}
