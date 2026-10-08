# 2024_tesla_model_3_rigged.glb — 节点契约

由 `2024_tesla_model_3__interior.glb`（B 模型）经 Blender 无头改装生成。
用途：灯光独立控制、四门独立开合、四轮独立转动、前轮转向、后视镜开合。

- 三角面 146,739 · 7.71 MB（源 167,747 / 11.02 MB）
- 坐标：glTF 标准 Y-up，前 = −Z，左 = +X，地面 y = 0
- 尺寸：宽 2.088 m × 高 1.444 m × 长 4.719 m（真车 1:1）
- 已删除：`DAMAGE_GLASS`（碎裂玻璃变体，默认叠在车顶）、`Rim_Blur_Spoke*`（行驶模糊假轮毂）

## 层级

```
CAR_ROOT
├─ BODY
│  ├─ BODY_GEO                         车身（含侧围骨架/顶棚/内饰非门件）
│  ├─ CALIPER_RL_GEO / CALIPER_RR_GEO  后轮卡钳（不转向不自转）
│  ├─ LIGHT_HEAD_FL_GEO / _FR          大灯（左右独立）
│  ├─ LIGHT_TAIL_RL_GEO / _RR          尾灯（左右独立）
│  └─ LIGHT_AMBIENT_GEO                环境灯带
├─ DOOR_FL  @ (0.80, 0.65, 0.92)   ← glTF 空间铰链
│  ├─ DOOR_FL_GEO                      门皮+玻璃+门卡+密封条+把手+LED
│  └─ MIRROR_FL  @ 门内
│     └─ MIRROR_FL_GEO                 后视镜总成
├─ DOOR_FR / MIRROR_FR                 右前（镜像）
├─ DOOR_RL / DOOR_RR                   后门（无镜）
├─ STEER_FL @ 前轮心
│  ├─ CALIPER_FL_GEO                   前卡钳（随转向、不随滚动）
│  └─ WHEEL_FL @ 前轮心
│     └─ WHEEL_FL_GEO                  轮胎+轮毂+刹车盘
├─ STEER_FR / WHEEL_FR
├─ WHEEL_RL                            后轮（无转向节点）
└─ WHEEL_RR
```

## 动画轴（three.js 中直接 rotate 节点）

| 节点 | 轴 | 正方向含义 | 参考行程 |
|---|---|---|---|
| `DOOR_FL` / `DOOR_RL` | local Y (up) | 负角 = 开门 | 0 → −58° 全开 |
| `DOOR_FR` / `DOOR_RR` | local Y (up) | 正角 = 开门 | 0 → +58° 全开 |
| `MIRROR_FL` | local Y | 负角 = 折叠（向后收） | 0 → −78° 全折 |
| `MIRROR_FR` | local Y | 正角 = 折叠 | 0 → +78° 全折 |
| `STEER_FL` / `STEER_FR` | local Y | ± 转向 | ±26° 明显可见 |
| `WHEEL_*` | local X | 滚动 | 任意，累加 |

要点：门、镜、转向节点的局部 Y 即世界竖直轴（节点无自身旋转），X 即轮轴横向。

## 灯光

每盏灯是独立 mesh + **按角复制的独立材质**（如 `Lights_HEAD_FL` / `Lights_HEAD_FR`），
点亮 = 把该角材质的 `emissiveFactor` 与 `emissiveTexture` 打开（three.js 里改 `material.emissive` / `emissiveIntensity`）。

| 材质前缀 | 位置 |
|---|---|
| `Lights_*_HEAD_FL/_FR`、`Lights_Glo_*`、`Lights_Ref_*`、`EXT_Headlight_Glass_*` | 大灯（近光/日行灯/反光碗/灯罩） |
| `Lights_*_TAIL_RL/_RR`、`EXT_Taillight_Glass_*`、`Taillight_Detail_*` | 尾灯 |
| `Lights_AMBIENT`、`Taillight_Detail_AMBIENT` | 车内环境灯带 |
| `INT_LED`（在门上，随门动） | 门内氛围灯 |

注意：`EXT_Headlight_Glass` 名字里**不含** `Lights`，按材质名过滤时要用 `light`（小写、子串）匹配。

## 再生成

改装脚本（Blender 5.2 无头，可重复执行）：
`C:\Users\11746\WorkBuddy\2026-09-28-15-34-02\model-compare\rig_tesla.py`

```bash
D:/software/blender/blender.exe -b --factory-startup -P rig_tesla.py
```

分类逻辑：材质+连通块原子化（9133 块）→ 按包围盒规则归组，不做几何切割（门缝线本就是模型真实几何间隙）。
