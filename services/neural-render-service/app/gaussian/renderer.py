from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class Projection:
    means: torch.Tensor
    conics: torch.Tensor
    radii: torch.Tensor
    colors: torch.Tensor
    opacity: torch.Tensor
    valid: torch.Tensor


def rotation_matrices(quaternions: torch.Tensor) -> torch.Tensor:
    w, x, y, z = nn.functional.normalize(quaternions, dim=-1).unbind(-1)
    return torch.stack([
        1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w),
        2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w),
        2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y),
    ], dim=-1).reshape(-1, 3, 3)


class GaussianModel(nn.Module):
    """Anisotropic 3D covariances, perspective projection and depth-ordered alpha blending.

    This portable PyTorch reference uses degree-0 color and fixed topology. It
    prioritizes a verifiable training/evaluation path over CUDA rasterizer speed.
    """

    tile_size = 16

    def __init__(self, means: torch.Tensor, colors: torch.Tensor, scales: torch.Tensor):
        super().__init__()
        self.means = nn.Parameter(means)
        self.colors = nn.Parameter(torch.logit(colors.clamp(0.005, 0.995)))
        self.log_scales = nn.Parameter(scales.log())
        self.quaternions = nn.Parameter(torch.tensor([1., 0., 0., 0.], device=means.device).repeat(len(means), 1))
        self.opacity = nn.Parameter(torch.full((len(means),), torch.logit(torch.tensor(0.65)).item(), device=means.device))

    def project(self, camera: dict) -> Projection:
        rotation, translation = camera["rotation"], camera["translation"]
        view = self.means @ rotation.T + translation
        x, y, z = view.unbind(-1)
        safe_z = z.clamp_min(0.01)
        uv = torch.stack([camera["fx"] * x / safe_z + camera["cx"],
                          camera["fy"] * y / safe_z + camera["cy"]], -1)
        basis = rotation_matrices(self.quaternions)
        covariance = (basis * self.log_scales.exp().square()[:, None, :]) @ basis.transpose(-1, -2)
        covariance = rotation[None] @ covariance @ rotation.T[None]
        zero = torch.zeros_like(z)
        jacobian = torch.stack([camera["fx"] / safe_z, zero, -camera["fx"] * x / safe_z.square(),
                                zero, camera["fy"] / safe_z, -camera["fy"] * y / safe_z.square()], -1).reshape(-1, 2, 3)
        cov2d = jacobian @ covariance @ jacobian.transpose(-1, -2)
        a = cov2d[:, 0, 0] + 0.3
        b = cov2d[:, 0, 1]
        c = cov2d[:, 1, 1] + 0.3
        determinant = (a*c - b*b).clamp_min(1e-8)
        conic = torch.stack([c, -b, a], -1) / determinant[:, None]
        largest = (a + c) / 2 + torch.sqrt(((a-c)/2).square() + b*b + 1e-8)
        radius = 3 * largest.clamp_min(0).sqrt()
        order = z.detach().argsort()
        valid = (z > 0.01) & torch.isfinite(uv).all(-1) & (radius < max(camera["width"], camera["height"]) * 2)
        return Projection(uv[order], conic[order], radius[order].detach(),
                          self.colors.sigmoid()[order], self.opacity.sigmoid()[order], valid[order])

    def render_tiles(self, projection: Projection, camera: dict, tile_ids: torch.Tensor,
                     background: torch.Tensor) -> torch.Tensor:
        size = self.tile_size
        columns = math.ceil(camera["width"] / size)
        top_left = torch.stack([tile_ids % columns, tile_ids // columns], -1) * size
        center = top_left + size / 2
        intersects = ((projection.means[None] - center[:, None]).abs()
                      <= projection.radii[None, :, None] + size / 2).all(-1) & projection.valid[None]
        count = max(1, int(intersects.sum(-1).max().item()))
        indices = torch.arange(len(projection.means), device=tile_ids.device)[None].expand(len(tile_ids), -1)
        selected = torch.where(intersects, indices, len(projection.means)).topk(count, dim=-1, largest=False, sorted=True).values
        valid = selected < len(projection.means)
        selected = selected.clamp_max(len(projection.means)-1)
        yy, xx = torch.meshgrid(torch.arange(size, device=tile_ids.device), torch.arange(size, device=tile_ids.device), indexing="ij")
        pixels = torch.stack([xx.flatten(), yy.flatten()], -1) + 0.5
        delta = pixels[None, None] + top_left[:, None, None] - projection.means[selected, None]
        dx, dy = delta.unbind(-1)
        conic = projection.conics[selected]
        exponent = conic[..., 0, None]*dx.square() + 2*conic[..., 1, None]*dx*dy + conic[..., 2, None]*dy.square()
        alpha = (projection.opacity[selected, None] * torch.exp(-0.5*exponent.clamp_min(0))
                 * valid[..., None] * (exponent <= 9)).clamp_max(0.99)
        transmittance = torch.cumprod(1-alpha+1e-7, dim=1)
        before = torch.cat([torch.ones_like(transmittance[:, :1]), transmittance[:, :-1]], dim=1)
        weights = alpha * before
        rgb = (weights[..., None] * projection.colors[selected, None, :]).sum(1)
        return rgb + transmittance[:, -1, :, None] * background

    def render(self, camera: dict, background: torch.Tensor, tile_batch: int = 8) -> torch.Tensor:
        size = self.tile_size
        rows, columns = math.ceil(camera["height"]/size), math.ceil(camera["width"]/size)
        projection = self.project(camera)
        tiles = torch.arange(rows*columns, device=self.means.device)
        patches = torch.cat([self.render_tiles(projection, camera, part, background)
                             for part in tiles.split(tile_batch)])
        return patches.reshape(rows, columns, size, size, 3).permute(0, 2, 1, 3, 4).reshape(
            rows*size, columns*size, 3)[:camera["height"], :camera["width"]].clamp(0, 1)
