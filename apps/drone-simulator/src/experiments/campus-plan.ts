export interface CampusCaptureView {
  id: string
  split: 'train' | 'test'
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
}

/** Test angles and heights are fixed before capture, and never enter training. */
export function campusCapturePlan(): CampusCaptureView[] {
  const views: CampusCaptureView[] = []
  const target = { x: 0, y: 22, z: -105 }
  for (const split of ['train', 'test'] as const) {
    const count = split === 'train' ? 16 : 4
    const heights = split === 'train' ? [150, 210] : [165, 195]
    for (let ring = 0; ring < heights.length; ring++)
      for (let index = 0; index < count; index++) {
        const angle = (((index * 360) / count + (split === 'test' ? 11.25 : 0)) * Math.PI) / 180
        views.push({
          id: `${split}-${ring}-${index.toString().padStart(2, '0')}`,
          split,
          position: {
            x: Math.sin(angle) * 300,
            y: heights[ring]!,
            z: -105 + Math.cos(angle) * 300,
          },
          target,
        })
      }
  }
  return views
}

/** New, predeclared held-out cameras; no reuse of the campus experiment's views. */
export function buildingCapturePlan(): CampusCaptureView[] {
  const views: CampusCaptureView[] = []
  for (const split of ['train', 'test'] as const) {
    const rings =
      split === 'train'
        ? [
            { y: 10, target: 14, radius: 46 },
            { y: 24, target: 18, radius: 46 },
            { y: 44, target: 23, radius: 46 },
            { y: 20, target: 20, radius: 34 },
          ]
        : [
            { y: 17, target: 17, radius: 55 },
            { y: 36, target: 22, radius: 55 },
          ]
    const count = split === 'train' ? 16 : 4
    rings.forEach((ring, ringIndex) => {
      for (let i = 0; i < count; i++) {
        const angle = (((i * 360) / count + (split === 'test' ? 14 : 0)) * Math.PI) / 180
        views.push({
          id: `building-${split}-${ringIndex}-${i.toString().padStart(2, '0')}`,
          split,
          position: {
            x: -104 + ring.radius * Math.sin(angle),
            y: ring.y,
            z: -30 + ring.radius * Math.cos(angle),
          },
          target: { x: -104, y: ring.target, z: -30 },
        })
      }
    })
  }
  return views
}
