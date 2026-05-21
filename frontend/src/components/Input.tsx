export function Input({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  type?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400">{label}</label>
      <input
        type={type}
        step="any"
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                   focus:outline-none focus:border-blue-500 disabled:opacity-40"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}
