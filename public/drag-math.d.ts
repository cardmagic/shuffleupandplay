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
