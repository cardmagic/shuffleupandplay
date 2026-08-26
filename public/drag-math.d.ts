export type Point = { x: number; y: number }
export type Corner = { left: number; top: number }

export declare function dragOffset(options: {
  pointer: Point
  canvas: Corner
  card: Corner
}): Point

export declare function dragPosition(options: {
  pointer: Point
  canvas: Corner
  offset: Point
}): Corner

export type CardFrame = {
  center: Point
  size: { width: number; height: number }
  rotation: number
}

export declare function rotationFromTransform(transform: string | undefined): number

export declare function cardPoint(options: { pointer: Point; frame: CardFrame }): Point
