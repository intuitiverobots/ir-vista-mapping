// ── Types ──────────────────────────────────────────────────────────────────

export type RecordStatus = 'idle' | 'recording' | 'done' | 'error'
export type PipelineStatus = 'idle' | 'running' | 'done' | 'error'

export interface SvoFile {
  name: string
  date: string
}

export interface PipelinePayload {
  config: string
  svo_stem: string
  output_name: string
  map_choice: 1 | 2
  extra_args: string[]
}

export interface ParamDef {
  key: string
  cli: string
  type: string   // "float" | "int" | "str" | "bool" | "choice:a,b,c"
  label: string
  value: string  // preset default as string
}

export interface DlSession {
  name: string
  date: string
}

export interface DlFile {
  path: string
  label: string
  size: number
  size_human: string
  group: 'raw' | 'output'
  is_dir: boolean
}
