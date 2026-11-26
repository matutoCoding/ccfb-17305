import type { FittingKind } from './types'

export const KIND_LABEL: Record<FittingKind, string> = {
  pipe: '直管段',
  elbow_lr: '90°长半径弯头',
  elbow_sr: '90°短半径弯头',
  elbow45: '45°弯头',
  tee: '三通',
  reducer_conc: '同心大小头',
  reducer_ecc: '偏心大小头',
  flange: '法兰',
  valve_gate: '闸阀',
  valve_check: '止回阀',
  valve_ball: '球阀',
  cap: '盲端/管帽'
}

export const KIND_SHORT: Record<FittingKind, string> = {
  pipe: '直管',
  elbow_lr: 'LR弯头',
  elbow_sr: 'SR弯头',
  elbow45: '45弯头',
  tee: '三通',
  reducer_conc: '同心异径',
  reducer_ecc: '偏心异径',
  flange: '法兰',
  valve_gate: '闸阀',
  valve_check: '止回阀',
  valve_ball: '球阀',
  cap: '盲端'
}

export const DIR_OPTIONS: { value: [number, number, number]; label: string }[] = [
  { value: [1, 0, 0], label: '+X 东' },
  { value: [-1, 0, 0], label: '−X 西' },
  { value: [0, 1, 0], label: '+Y 上' },
  { value: [0, -1, 0], label: '−Y 下' },
  { value: [0, 0, 1], label: '+Z 南' },
  { value: [0, 0, -1], label: '−Z 北' }
]

export function dirLabel(d: number[]): string {
  const found = DIR_OPTIONS.find((o) => o.value[0] === d[0] && o.value[1] === d[1] && o.value[2] === d[2])
  return found?.label ?? `(${d.join(',')})`
}
