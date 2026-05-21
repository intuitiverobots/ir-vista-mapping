export function Select({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400">{label}</label>
      <select
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                   focus:outline-none focus:border-blue-500 disabled:opacity-40"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
