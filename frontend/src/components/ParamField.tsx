import type { ParamDef } from '../types'
import { Input } from './Input'
import { Select } from './Select'

// ── Labeled integer enum params ─────────────────────────────────────────

export const PARAM_INT_ENUMS: Record<string, Record<string, string>> = {
  quality: {
    '0': 'NONE',
    '1': 'Performance (deprecated)',
    '2': 'Quality (deprecated)',
    '3': 'Ultra (deprecated)',
    '4': 'Neural',
    '5': 'Neural Light',
    '6': 'Neural+',
  },
  'rtabmap.Optimizer/Strategy': {
    '0': 'TORO',
    '1': 'g2o',
    '2': 'GTSAM',
    '3': 'Ceres',
  },
}

export function ParamField({
  p,
  value,
  onChange,
  disabled,
}: {
  p: ParamDef
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  if (p.type === 'bool') {
    return (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`param-${p.key}`}
          checked={value === 'true'}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          disabled={disabled}
          className="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-blue-500 disabled:opacity-40"
        />
        <label htmlFor={`param-${p.key}`} className="text-xs text-gray-300">{p.label}</label>
      </div>
    )
  }
  if (p.type === 'int' && PARAM_INT_ENUMS[p.key]) {
    return (
      <Select
        label={p.label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={Object.entries(PARAM_INT_ENUMS[p.key]).map(([v, l]) => ({ value: v, label: `${v} – ${l}` }))}
      />
    )
  }
  if (p.type.startsWith('choice:')) {
    const choices = p.type.slice(7).split(',')
    return (
      <Select
        label={p.label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={choices.map(c => ({ value: c, label: c }))}
      />
    )
  }
  return (
    <Input
      label={p.label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      type={p.type === 'float' || p.type === 'int' ? 'number' : 'text'}
      placeholder={p.value}
    />
  )
}
