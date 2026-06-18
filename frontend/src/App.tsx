import { useState, useEffect, useRef } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import type { RecordStatus, PipelineStatus, SvoFile, PipelinePayload, ParamDef, DlSession, DlFile } from './types'
import { Input } from './components/Input'
import { Select } from './components/Select'
import { ParamField } from './components/ParamField'
import { useLogStream } from './hooks/useLogStream'

// ── API helpers ───────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText)
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'PUT',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText)
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

async function apiDelete<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'DELETE' })
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText)
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}



// ── ZED resolution / FPS compatibility ──────────────────────────────────

interface ZedResolution {
  name: string
  label: string   // display label
  fps: number[]   // supported FPS values, descending
}

const ZED_RESOLUTIONS: ZedResolution[] = [
  { name: 'HD2K',   label: 'HD2K   – 4416×1242 (Wide)',        fps: [15]             },
  { name: 'HD1080', label: 'HD1080 – 3840×1080 (Wide)',        fps: [30, 15]         },
  { name: 'HD720',  label: 'HD720  – 2560×720 (Extra Wide)',   fps: [60, 30, 15]     },
  { name: 'VGA',    label: 'VGA    – 1344×376 (Extra Wide)',   fps: [100, 60, 30, 15] },
]

const ZED_RES_MAP: Record<string, ZedResolution> = Object.fromEntries(
  ZED_RESOLUTIONS.map(r => [r.name, r])
)

// ── Pipeline step groups ──────────────────────────────────────────────────

const GLOBAL_PARAM_KEYS = new Set(['trim_start', 'trim_end', 'depth_scale'])

interface StepGroup {
  id: string
  label: string
  keys: Set<string>
  includeRtabmap?: boolean
  skipFlag?: string | null
}

const EASTER_EGG_MESSAGES = [
  '🚀 Pipeline successfully completed in 0.0001 ms! New personal best. (Tip: try checking at least one box next time).',
  'Request to process the void received. The robot thought long and hard about nothing, and absolutely loved it.',
  'No steps selected. I used this free time to meditate on the meaning of life and sort my bits.',
  'Error 404: Intention to work not found. Please check at least one box to wake up the processor.',
  'Executing DoNothing() algorithm... Absolute success.',
]

const STEP_GROUPS: StepGroup[] = [
  {
    id: 'camera',
    label: 'Step 1 – Camera intrinsics (zed_camera_info.py)',
    keys: new Set<string>(),
    skipFlag: '--skip-camera-info',
  },
  {
    id: 'slam',
    label: 'Step 2 – SLAM (process_svo.py)',
    keys: new Set(['render', 'superpoint', 'quality', 'regen_grid']),
    includeRtabmap: true,
    skipFlag: '--skip-slam',
  },
  {
    id: 'video',
    label: 'Step 3 – SVO export (svo_export.py)',
    keys: new Set(['side', 'depth_compression']),
    skipFlag: null,
  },
  {
    id: 'poses',
    label: 'Step 4 – Pose conversion (convert_poses.py)',
    keys: new Set<string>(),
    skipFlag: '--skip-poses',
  },
  {
    id: 'projection',
    label: 'Step 5 – 2D projection (project_ply.py)',
    keys: new Set(['min_z', 'max_z', 'resolution']),
    skipFlag: '--skip-projection',
  },
  {
    id: 'zip',
    label: 'Step 6 – ZIP assembly',
    keys: new Set<string>(),
    skipFlag: '--skip-zip',
  },
]

// ── All known param definitions (used for new preset creation) ────────────────

const ALL_KNOWN_PARAMS: ParamDef[] = [
  { key: 'side',              cli: '--side',              type: 'choice:left,right',         label: 'side (camera side)',              value: 'right'  },
  { key: 'render',            cli: '--render',            type: 'choice:cloud,mesh,texture',  label: 'render (3D export mode)',          value: 'cloud'  },
  { key: 'quality',           cli: '--quality',           type: 'int',                        label: 'quality (ZED depth mode)', value: '5'      },
  { key: 'superpoint',        cli: '--superpoint',        type: 'bool',                       label: 'superpoint (SuperPoint features)', value: 'false'  },
  { key: 'min_z',             cli: '--min-z',             type: 'float',                      label: 'min_z (min height, m)',            value: '0.0'    },
  { key: 'max_z',             cli: '--max-z',             type: 'float',                      label: 'max_z (max height, m)',            value: '2.0'    },
  { key: 'resolution',        cli: '--resolution',        type: 'float',                      label: 'resolution (cell size, m/px)',     value: '0.05'   },
  { key: 'depth_scale',       cli: '--depth-scale',       type: 'float',                      label: 'depth_scale (scale factor)',       value: '0.75'   },
  { key: 'depth_compression', cli: '--depth-compression', type: 'int',                        label: 'depth_compression (PNG 0-9)',      value: '5'      },
  { key: 'trim_start',        cli: '--trim-start',        type: 'float',                      label: 'trim_start (skip start, s)',       value: '0.0'    },
  { key: 'trim_end',          cli: '--trim-end',          type: 'float',                      label: 'trim_end (skip end, s)',           value: '0.0'    },
  { key: 'regen_grid',        cli: '--regen-grid',        type: 'bool',                       label: 'regen_grid (rebuild grid only)',   value: 'false'  },
]



// ── Main component ────────────────────────────────────────────────────────

export default function App() {
  // ── Capture state ──────────────────────────────────────────────
  const [sessionName, setSessionName] = useState('')
  const [resolution, setResolution] = useState('HD720')
  const [fps, setFps] = useState('60')
  const [imuWarmup, setImuWarmup] = useState('2.0')
  const [captureWait, setCaptureWait] = useState('0')
  const [showCaptureAdvanced, setShowCaptureAdvanced] = useState(false)
  const [recordStatus, setRecordStatus] = useState<RecordStatus>('idle')
  const [frameCount, setFrameCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [recordLogs, setRecordLogs] = useState<string[]>([])
  const [recordSseUrl, setRecordSseUrl] = useState<string | null>(null)
  const startTimeRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  // ── Pipeline state ─────────────────────────────────────────────
  const [configs, setConfigs] = useState<string[]>([])
  const [svos, setSvos] = useState<SvoFile[]>([])
  const [selectedConfig, setSelectedConfig] = useState('')
  const [selectedSvo, setSelectedSvo] = useState('')
  const [outputName, setOutputName] = useState('')
  const [mapChoice, setMapChoice] = useState<'1' | '2'>('2')
  const [presetParams, setPresetParams] = useState<ParamDef[]>([])
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [stepEnabled, setStepEnabled] = useState<Record<string, boolean>>({
    camera: true, slam: true, video: true, poses: true, projection: true, zip: true,
  })
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({
    camera: false, slam: false, video: false, poses: false, projection: false, zip: false,
  })
  const [exportVideo, setExportVideo] = useState(true)
  const [recordAudio, setRecordAudio] = useState(true)
  const [exportDepth, setExportDepth] = useState(true)
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>('idle')
  const [zipReady, setZipReady] = useState(false)
  const [zipDownloading, setZipDownloading] = useState(false)
  const [pipelineSseUrl, setPipelineSseUrl] = useState<string | null>(null)
  const pipelineStream = useLogStream(pipelineSseUrl)
  const recordLogContainerRef = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const [extraCliArgs, setExtraCliArgs] = useState('')

  // ── Download state ──────────────────────────────────────────────
  const [dlSessions, setDlSessions] = useState<DlSession[]>([])
  const [dlSession, setDlSession] = useState('')
  const [dlFiles, setDlFiles] = useState<DlFile[]>([])
  const [dlChecked, setDlChecked] = useState<Set<string>>(new Set())
  const [dlLoading, setDlLoading] = useState(false)
  const [dlZipping, setDlZipping] = useState(false)

  const [showNewPreset, setShowNewPreset] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetParams, setNewPresetParams] = useState<Record<string, string>>({})
  const [newPresetRtabmap, setNewPresetRtabmap] = useState<{ k: string; v: string }[]>([])
  const [newPresetSaving, setNewPresetSaving] = useState(false)

  // ── Load configs and restore process states on mount ───────────
  const fetchSvos = () =>
    apiGet<{ svos: SvoFile[] }>('/api/svos')
      .then(d => { setSvos(d.svos); if (d.svos.length > 0 && !selectedSvo) setSelectedSvo(d.svos[0].name) })
      .catch(console.error)

  useEffect(() => {
    apiGet<{ configs: string[] }>('/api/configs')
      .then(d => { setConfigs(d.configs); if (d.configs.length > 0) setSelectedConfig(d.configs[0]) })
      .catch(console.error)

    fetchSvos()

    apiGet<{ record: string; pipeline: string }>('/api/status')
      .then(s => {
        if (s.record === 'running') {
          setRecordStatus('recording')
          setRecordSseUrl(`/api/logs/record?t=${Date.now()}`)
        } else if (s.record === 'done') setRecordStatus('done')
        else if (s.record === 'error') setRecordStatus('error')

        if (s.pipeline === 'running') {
          setPipelineStatus('running')
          setPipelineSseUrl(`/api/logs/pipeline?t=${Date.now()}`)
        } else if (s.pipeline === 'done') setPipelineStatus('done')
        else if (s.pipeline === 'error') setPipelineStatus('error')
      })
      .catch(console.error)
  }, [])

  // ── Fetch preset params when config changes ────────────────────
  useEffect(() => {
    if (!selectedConfig) { setPresetParams([]); setParamValues({}); return }
    apiGet<{ params: ParamDef[] }>(`/api/presets/${selectedConfig}`)
      .then(d => {
        setPresetParams(d.params)
        const defaults: Record<string, string> = {}
        for (const p of d.params) defaults[p.key] = p.value
        setParamValues(defaults)
      })
      .catch(console.error)
  }, [selectedConfig])

  // ── Auto-scroll logs (only if already at bottom, scoped to container) ───
  useEffect(() => {
    const el = recordLogContainerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (isAtBottom) el.scrollTop = el.scrollHeight
  }, [recordLogs])

  useEffect(() => {
    const el = logContainerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (isAtBottom) el.scrollTop = el.scrollHeight
  }, [pipelineStream.logs])

  // ── SSE: record ────────────────────────────────────────────────
  useEffect(() => {
    if (!recordSseUrl) return
    const sse = new EventSource(recordSseUrl)
    sse.onmessage = (e: MessageEvent<string>) => {
      const data = e.data
      if (data.startsWith('[DONE] exit=')) {
        const m = data.match(/exit=(-?\d+)/)
        const ok = m && m[1] === '0'
        setRecordStatus(ok ? 'done' : 'error')
        setRecordLogs(prev => [...prev, ok ? '[OK] Recording done.' : `[ERROR] Exit code ${m?.[1]}.`])
        setRecordSseUrl(null)
        if (timerRef.current) clearInterval(timerRef.current)
        sse.close()
      } else {
        const fm = data.match(/Frame count:\s*(\d+)/i)
        if (fm) {
          const count = parseInt(fm[1])
          setFrameCount(count)
          // Start the timer on the very first frame
          if (count === 1 && !timerRef.current) {
            startTimeRef.current = Date.now()
            timerRef.current = setInterval(
              () => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)),
              1000,
            )
          }
        } else if (data && !data.startsWith(':')) {
          setRecordLogs(prev => [...prev, data])
        }
      }
    }
    sse.onerror = () => sse.close()
    return () => sse.close()
  }, [recordSseUrl])

  // ── SSE: pipeline (via useLogStream hook) ─────────────────────
  useEffect(() => {
    if (pipelineStream.exitCode === null) return
    const ok = pipelineStream.exitCode === 0
    setPipelineStatus(ok ? 'done' : 'error')
    if (ok && stepEnabled['zip']) setZipReady(true)
    setPipelineSseUrl(null)
  }, [pipelineStream.exitCode])

  // ── Handlers ───────────────────────────────────────────────────

  const handleStartRecording = async () => {
    if (!sessionName.trim()) { alert('A session name is required'); return }

    // Request microphone access before starting anything
    let audioStream: MediaStream | null = null
    if (recordAudio) {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        if (!window.confirm('Microphone access denied. Continue recording without audio?')) return
      }
    }

    try {
      await apiPost('/api/record/start', {
        session_name: sessionName.trim(),
        resolution,
        fps: parseInt(fps),
        imu_warmup: isNaN(parseFloat(imuWarmup)) ? 2.0 : parseFloat(imuWarmup),
        wait: isNaN(parseInt(captureWait)) ? 0 : parseInt(captureWait),
      })
      setRecordStatus('recording')
      setFrameCount(0)
      setElapsed(0)
      setRecordLogs([])
      timerRef.current = null
      setRecordSseUrl(`/api/logs/record?t=${Date.now()}`)

      // Start audio aligned with actual SVO first frame (after imu_warmup + wait)
      if (audioStream) {
        audioChunksRef.current = []
        const mr = new MediaRecorder(audioStream)
        mr.ondataavailable = (e: BlobEvent) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data)
        }
        mr.onstop = () => {
          audioStream!.getTracks().forEach(t => t.stop())
          const blob = new Blob(audioChunksRef.current, { type: mr.mimeType })
          const form = new FormData()
          form.append('file', blob, `${sessionName.trim()}.webm`)
          form.append('session_name', sessionName.trim())
          fetch('/api/record/audio', { method: 'POST', body: form })
            .then(r => { if (!r.ok) console.error('Audio upload failed', r.status) })
            .catch(err => console.error('Audio upload error', err))
        }
        const delayMs = ((isNaN(parseFloat(imuWarmup)) ? 2.0 : parseFloat(imuWarmup))
          + (isNaN(parseInt(captureWait)) ? 0 : parseInt(captureWait))) * 1000
        setTimeout(() => { mr.start(); mediaRecorderRef.current = mr }, delayMs)
      }
    } catch (err) {
      audioStream?.getTracks().forEach(t => t.stop())
      alert(`Failed to start recording: ${err instanceof Error ? err.message : err}`)
    }
  }

  const handleStopRecording = async () => {
    try {
      await apiPost('/api/record/stop')
      if (timerRef.current) clearInterval(timerRef.current)
      // Stop audio capture — onstop handler uploads the file
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
        mediaRecorderRef.current = null
      }
    } catch (err) {
      alert(`Failed to stop recording: ${err instanceof Error ? err.message : err}`)
    }
  }

  const handleKillPipeline = async () => {
    try {
      await apiPost('/api/pipeline/stop')
    } catch (err) {
      alert(`Failed to kill pipeline: ${err instanceof Error ? err.message : err}`)
    }
  }

  const handleStartPipeline = async () => {
    if (!selectedConfig) { alert('Select a preset'); return }
    if (!selectedSvo) { alert('Select an SVO2 file'); return }
    if (STEP_GROUPS.every(g => !stepEnabled[g.id])) {
      toast(EASTER_EGG_MESSAGES[Math.floor(Math.random() * EASTER_EGG_MESSAGES.length)], {
        icon: '🤔',
        duration: 6000,
        style: { maxWidth: '480px' },
      })
      return
    }
    setZipReady(false)
    try {
      const extra_args: string[] = []
      // Step enable/disable flags
      for (const group of STEP_GROUPS) {
        if (!group.skipFlag) continue
        if (!stepEnabled[group.id]) {
          extra_args.push(group.skipFlag)
        }
      }
      // Video step: two independent sub-flags
      if (!stepEnabled['video']) {
        extra_args.push('--skip-video', '--skip-depth')
      } else {
        if (!exportVideo) extra_args.push('--skip-video')
        if (!exportDepth) extra_args.push('--skip-depth')
      }
      // Param values (run_pipeline.py / process_svo.py handle unused params gracefully)
      for (const p of presetParams) {
        const val = paramValues[p.key] ?? p.value
        if (p.type === 'bool') {
          if (val === 'true') {
            extra_args.push(p.cli)
          }
        } else {
          extra_args.push(p.cli, val)
        }
      }
      if (extraCliArgs.trim()) {
        extra_args.push(...extraCliArgs.trim().split(/\s+/))
      }
      const payload: PipelinePayload = {
        config: selectedConfig,
        svo_stem: selectedSvo,
        output_name: outputName.trim() || selectedSvo,
        map_choice: mapChoice === '1' ? 1 : 2,
        extra_args,
      }
      await apiPost('/api/pipeline/start', payload)
      setPipelineStatus('running')
      setPipelineSseUrl(`/api/logs/pipeline?t=${Date.now()}`)
    } catch (err) {
      alert(`Failed to start pipeline: ${err instanceof Error ? err.message : err}`)
    }
  }

  const hasUnsavedChanges = Boolean(selectedConfig) &&
  presetParams.some(p => (paramValues[p.key] ?? p.value) !== p.value)

const handleUpdatePreset = async () => {
  if (!selectedConfig) return
  try {
    const values: Record<string, string> = {}
    const rtabmap: Record<string, string> = {}
    for (const p of presetParams) {
      const val = paramValues[p.key] ?? p.value
      if (p.key.startsWith('rtabmap.')) rtabmap[p.key.slice(8)] = val
      else values[p.key] = val
    }
    await apiPut(`/api/presets/${encodeURIComponent(selectedConfig)}`, { values, rtabmap })
    // Reload to reset unsaved-changes indicator
    const data = await apiGet<{ params: ParamDef[] }>(`/api/presets/${selectedConfig}`)
    setPresetParams(data.params)
    const defaults: Record<string, string> = {}
    for (const p of data.params) defaults[p.key] = p.value
    setParamValues(defaults)
    toast.success(`Preset "${selectedConfig}" updated.`)
  } catch (err) {
    toast.error(`Update failed: ${err instanceof Error ? err.message : err}`)
  }
}

const handleDeletePreset = async () => {
  if (!selectedConfig) return
  if (!window.confirm(`Delete preset "${selectedConfig}"? This cannot be undone.`)) return
  try {
    await apiDelete(`/api/presets/${encodeURIComponent(selectedConfig)}`)
    toast.success(`Preset "${selectedConfig}" deleted.`)
    setSelectedConfig('')
    const data = await apiGet<{ configs: string[] }>('/api/configs')
    setConfigs(data.configs)
  } catch (err) {
    toast.error(`Delete failed: ${err instanceof Error ? err.message : err}`)
  }
}

  // ── Download handlers ──────────────────────────────────────────

  const fetchDlSessions = () =>
    apiGet<{ sessions: DlSession[] }>('/api/sessions')
      .then(d => setDlSessions(d.sessions))
      .catch(console.error)

  const fetchDlFiles = async (name: string) => {
    if (!name) { setDlFiles([]); setDlChecked(new Set()); return }
    setDlLoading(true)
    try {
      const data = await apiGet<{ files: DlFile[] }>(`/api/sessions/${encodeURIComponent(name)}/files`)
      setDlFiles(data.files)
      setDlChecked(new Set(data.files.map(f => f.path)))
    } catch (err) {
      toast.error(`Failed to fetch files: ${err instanceof Error ? err.message : err}`)
    } finally {
      setDlLoading(false)
    }
  }

  const handleDownload = async () => {
    if (!dlSession || dlChecked.size === 0) return
    setDlZipping(true)
    try {
      const paths = [...dlChecked]
      // Single non-directory file → direct download, no ZIP
      if (paths.length === 1) {
        const single = dlFiles.find(f => f.path === paths[0] && !f.is_dir)
        if (single) {
          const r = await fetch(
            `/api/sessions/file?session=${encodeURIComponent(dlSession)}&path=${encodeURIComponent(paths[0])}`
          )
          if (!r.ok) {
            const msg = await r.text().catch(() => r.statusText)
            throw new Error(msg)
          }
          const blob = await r.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = single.label
          a.click()
          URL.revokeObjectURL(url)
          return
        }
      }
      // Multiple files or single directory → ZIP
      const r = await fetch('/api/sessions/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: dlSession, paths }),
      })
      if (!r.ok) {
        const msg = await r.text().catch(() => r.statusText)
        throw new Error(msg)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${dlSession}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(`Download failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setDlZipping(false)
    }
  }

  // ── Derived ────────────────────────────────────────────────────
  const handleOpenNewPreset = () => {
    const initValues: Record<string, string> = {}
    for (const p of ALL_KNOWN_PARAMS) {
      initValues[p.key] = paramValues[p.key] ?? p.value
    }
    const rtab = presetParams
      .filter(p => p.key.startsWith('rtabmap.'))
      .map(p => ({ k: p.key.slice(8), v: paramValues[p.key] ?? p.value }))
    setNewPresetName('')
    setNewPresetParams(initValues)
    setNewPresetRtabmap(rtab)
    setShowNewPreset(true)
  }

  const handleSavePreset = async () => {
    const name = newPresetName.trim()
    if (!name) return
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      toast.error('Preset name must be alphanumeric (underscores and hyphens allowed)')
      return
    }
    setNewPresetSaving(true)
    try {
      const rtabmap: Record<string, string> = {}
      for (const row of newPresetRtabmap) {
        if (row.k.trim()) rtabmap[row.k.trim()] = row.v
      }
      await apiPost('/api/presets', { name, values: newPresetParams, rtabmap })
      toast.success(`Preset "${name}" created.`)
      setShowNewPreset(false)
      const data = await apiGet<{ configs: string[] }>('/api/configs')
      setConfigs(data.configs)
      setSelectedConfig(name)
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setNewPresetSaving(false)
    }
  }

  const isRecording = recordStatus === 'recording'
  const isPipelineRunning = pipelineStatus === 'running'
  const zipSession = outputName.trim() || selectedSvo

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Toaster position="bottom-center" toastOptions={{ style: { background: '#1f2937', color: '#f3f4f6', border: '1px solid #374151' } }} />
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-bold tracking-tight text-white">Vista Capture App</h1>
            <span className="text-sm text-gray-500">ZED2i · RTAB-Map · Jetson Orin</span>
          </div>
          <img src="/logo.png" alt="Logo" className="h-8 w-auto" />
        </div>
      </header>

      {/* Two-panel layout */}
      <main className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-7xl mx-auto">

        {/* ──────────────────── Capture Panel ──────────────────── */}
        <section className="bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Capture</h2>
            {isRecording && (
              <span className="flex items-center gap-2 text-sm text-red-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                RECORDING
              </span>
            )}
            {recordStatus === 'done' && <span className="text-sm text-green-400">✓ Done</span>}
            {recordStatus === 'error' && <span className="text-sm text-red-400">✗ Error</span>}
          </div>

          <Input
            label="Session name"
            value={sessionName}
            onChange={setSessionName}
            placeholder="Session name"
            disabled={isRecording}
          />

          <Select
            label="Resolution"
            value={resolution}
            onChange={res => {
              setResolution(res)
              // Clamp FPS to the highest supported by the new resolution
              const supported = ZED_RES_MAP[res].fps
              if (!supported.includes(parseInt(fps))) setFps(String(supported[0]))
            }}
            disabled={isRecording}
            options={ZED_RESOLUTIONS.map(r => ({ value: r.name, label: r.label }))}
          />

          <Select
            label="FPS"
            value={fps}
            onChange={setFps}
            disabled={isRecording}
            options={ZED_RES_MAP[resolution].fps.map(f => ({ value: String(f), label: `${f} fps` }))}
          />

          {/* Advanced settings – capture */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="record-audio-check"
              checked={recordAudio}
              onChange={e => setRecordAudio(e.target.checked)}
              disabled={isRecording}
              className="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-blue-500 disabled:opacity-40"
            />
            <label htmlFor="record-audio-check" className="text-sm text-gray-300">Record audio</label>
          </div>

          {/* Advanced settings – capture */}
          <div>
            <button
              onClick={() => setShowCaptureAdvanced(v => !v)}
              disabled={isRecording}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
            >
              <span>{showCaptureAdvanced ? '▾' : '▸'}</span>
              <span>Advanced settings</span>
            </button>
            {showCaptureAdvanced && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Input
                  label="imu_warmup (warmup, s)"
                  value={imuWarmup}
                  onChange={setImuWarmup}
                  disabled={isRecording}
                  type="number"
                  placeholder="2.0"
                />
                <Input
                  label="wait (start delay, s)"
                  value={captureWait}
                  onChange={setCaptureWait}
                  disabled={isRecording}
                  type="number"
                  placeholder="0"
                />
              </div>
            )}
          </div>

          {/* Live stats while recording */}
          {isRecording && (
            <div className="bg-gray-800 rounded-xl px-5 py-4 space-y-1">
              <div className="text-3xl font-mono tabular-nums tracking-tight">
                {frameCount > 0 ? fmtTime(elapsed) : '––:––'}
              </div>
              <div className="text-sm text-gray-400">
                {frameCount > 0 ? `${frameCount.toLocaleString()} frames` : 'Initializing…'}
              </div>
            </div>
          )}

          {!isRecording ? (
            <button
              onClick={handleStartRecording}
              className="w-full bg-blue-600 hover:bg-blue-500 rounded-xl py-2.5 text-sm
                         font-medium transition-colors"
            >
              Start Recording
            </button>
          ) : (
            <button
              onClick={handleStopRecording}
              className="w-full bg-red-700 hover:bg-red-600 rounded-xl py-2.5 text-sm
                         font-medium transition-colors"
            >
              Stop Recording
            </button>
          )}

          {/* Record log console */}
          {recordLogs.length > 0 && (
            <div ref={recordLogContainerRef} className="log-console bg-gray-950 border border-gray-800 rounded-xl p-3 h-40
                            overflow-y-auto font-mono text-xs leading-relaxed">
              {recordLogs.map((line, i) => (
                <div
                  key={i}
                  className={
                    /\[ERROR\]|error|Error/i.test(line)
                      ? 'text-red-400'
                      : /\[OK\]/i.test(line)
                      ? 'text-green-400'
                      : 'text-gray-300'
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ──────────────────── SLAM & Export Pipeline Panel ───── */}
        <section className="bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">SLAM &amp; Export Pipeline</h2>
            {isPipelineRunning && (
              <span className="flex items-center gap-2 text-sm text-yellow-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                Running
              </span>
            )}
            {pipelineStatus === 'done' && <span className="text-sm text-green-400">✓ Done</span>}
            {pipelineStatus === 'error' && <span className="text-sm text-red-400">✗ Error</span>}
          </div>

          {/* SVO2 file dropdown */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">SVO2 file</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                         focus:outline-none focus:border-blue-500 disabled:opacity-40"
              value={selectedSvo}
              onFocus={fetchSvos}
              onChange={e => { setSelectedSvo(e.target.value); setOutputName(e.target.value) }}
              disabled={isPipelineRunning}
            >
              <option value="">— select —</option>
              {svos.map(s => <option key={s.name} value={s.name}>{s.name}.svo2 ({s.date})</option>)}
            </select>
          </div>

          {/* Output folder name */}
          <Input
            label="Output folder (data/outputs/…)"
            value={outputName}
            onChange={setOutputName}
            placeholder={selectedSvo || 'output name'}
            disabled={isPipelineRunning}
          />

          {/* Preset dropdown */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="block text-xs text-gray-400">Preset</label>
                {hasUnsavedChanges && (
                  <span className="text-xs text-yellow-400 font-medium">● unsaved changes</span>
                )}
              </div>
              <button
                onClick={handleOpenNewPreset}
                disabled={isPipelineRunning}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors"
              >
                + New preset
              </button>
            </div>
            <div className="flex gap-2">
              <select
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                          focus:outline-none focus:border-blue-500 disabled:opacity-40"
                value={selectedConfig}
                onChange={e => setSelectedConfig(e.target.value)}
                disabled={isPipelineRunning}
              >
                <option value="">— select —</option>
                {configs.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
              {selectedConfig && (
                <>
                  {hasUnsavedChanges && (
                    <button
                      onClick={handleUpdatePreset}
                      disabled={isPipelineRunning}
                      title="Save current values into this preset"
                      className="px-2 py-1 rounded-lg text-xs bg-yellow-700 hover:bg-yellow-600
                                disabled:opacity-40 transition-colors whitespace-nowrap"
                    >
                      ↑ Update
                    </button>
                  )}
                  <button
                    onClick={handleDeletePreset}
                    disabled={isPipelineRunning}
                    title="Delete this preset"
                    className="px-2 py-1 rounded-lg text-xs text-red-400 hover:text-red-300
                              border border-red-800 hover:border-red-600 disabled:opacity-40 transition-colors"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Advanced parameters — step accordions */}
          <div>
            <button
              onClick={() => setShowAdvanced(v => !v)}
              disabled={isPipelineRunning}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
            >
              <span>{showAdvanced ? '▾' : '▸'}</span>
              <span>Advanced parameters</span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3">

                {/* Select all / Deselect all steps */}
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      const next: Record<string, boolean> = {}
                      STEP_GROUPS.forEach(g => { next[g.id] = true })
                      setStepEnabled(next)
                    }}
                    disabled={isPipelineRunning}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40"
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => {
                      const next: Record<string, boolean> = {}
                      STEP_GROUPS.forEach(g => { next[g.id] = false })
                      setStepEnabled(next)
                    }}
                    disabled={isPipelineRunning}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40"
                  >
                    Deselect all
                  </button>
                </div>

                {/* Global params (apply to multiple steps) */}
                {(() => {
                  const globals = presetParams.filter(p => GLOBAL_PARAM_KEYS.has(p.key))
                  if (globals.length === 0) return null
                  return (
                    <div className="grid grid-cols-2 gap-3 pb-1">
                      {globals.map(p => (
                        <ParamField
                          key={p.key}
                          p={p}
                          value={paramValues[p.key] ?? p.value}
                          onChange={v => setParamValues(prev => ({ ...prev, [p.key]: v }))}
                          disabled={isPipelineRunning}
                        />
                      ))}
                    </div>
                  )
                })()}

                {/* Per-step accordions — all 6, always rendered */}
                {STEP_GROUPS.map(group => {
                  const groupParams = presetParams.filter(p =>
                    group.keys.has(p.key) ||
                    (group.includeRtabmap === true && p.key.startsWith('rtabmap.'))
                  )
                  const hasContent = groupParams.length > 0 || group.id === 'zip' || group.id === 'video'
                  const isEnabled = stepEnabled[group.id] ?? true
                  const isOpen = openSteps[group.id] ?? false
                  return (
                    <div key={group.id} className="border border-gray-700 rounded-xl overflow-hidden">
                      {/* Header: checkbox + label + expand arrow */}
                      <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-800/70">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={e => setStepEnabled(prev => ({ ...prev, [group.id]: e.target.checked }))}
                          disabled={isPipelineRunning}
                          className="h-4 w-4 flex-shrink-0 rounded border-gray-600 accent-blue-500 disabled:opacity-40"
                        />
                        <button
                          onClick={() => hasContent && setOpenSteps(prev => ({ ...prev, [group.id]: !prev[group.id] }))}
                          disabled={isPipelineRunning || !hasContent}
                          className="flex-1 flex items-center justify-between text-left gap-2 disabled:cursor-default"
                        >
                          <span className={`text-xs font-medium ${
                            isEnabled ? 'text-gray-200' : 'line-through text-gray-500'
                          }`}>
                            {group.label}
                          </span>
                          {hasContent && (
                            <span className="text-gray-500 text-xs flex-shrink-0">{isOpen ? '▾' : '▸'}</span>
                          )}
                        </button>
                      </div>

                      {/* Params body */}
                      {isOpen && hasContent && (
                        <div className="p-3 space-y-3 border-t border-gray-700">
                          {group.id === 'zip' && (
                            <Select
                              label="map_choice (map source for ZIP)"
                              value={mapChoice}
                              onChange={v => setMapChoice(v as '1' | '2')}
                              disabled={isPipelineRunning || !isEnabled}
                              options={[
                                { value: '1', label: 'RTAB-Map built-in (map.pgm)' },
                                { value: '2', label: 'Manual projection (map_manual.pgm)' },
                              ]}
                            />
                          )}
                          {group.id === 'video' ? (() => {
                            const sideParam = groupParams.find(p => p.key === 'side')
                            const comprParam = groupParams.find(p => p.key === 'depth_compression')
                            const dis = isPipelineRunning || !isEnabled
                            return (
                              <div className="grid grid-cols-2 gap-3">
                                {/* Col 1: side dropdown + Export MP4 checkbox */}
                                <div className="space-y-1">
                                  {sideParam && (
                                    <ParamField
                                      p={sideParam}
                                      value={paramValues[sideParam.key] ?? sideParam.value}
                                      onChange={v => setParamValues(prev => ({ ...prev, [sideParam.key]: v }))}
                                      disabled={dis || !exportVideo}
                                    />
                                  )}
                                  <div className="flex items-center gap-2 pt-1">
                                    <input
                                      type="checkbox"
                                      id="export-video-check"
                                      checked={exportVideo}
                                      onChange={e => setExportVideo(e.target.checked)}
                                      disabled={dis}
                                      className="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-blue-500 disabled:opacity-40"
                                    />
                                    <label htmlFor="export-video-check" className="text-xs text-gray-300">Export MP4</label>
                                  </div>
                                </div>
                                {/* Col 2: depth compression + Export depth checkbox */}
                                <div className="space-y-1">
                                  {comprParam && (
                                    <ParamField
                                      p={comprParam}
                                      value={paramValues[comprParam.key] ?? comprParam.value}
                                      onChange={v => setParamValues(prev => ({ ...prev, [comprParam.key]: v }))}
                                      disabled={dis || !exportDepth}
                                    />
                                  )}
                                  <div className="flex items-center gap-2 pt-1">
                                    <input
                                      type="checkbox"
                                      id="export-depth-check"
                                      checked={exportDepth}
                                      onChange={e => setExportDepth(e.target.checked)}
                                      disabled={dis}
                                      className="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-blue-500 disabled:opacity-40"
                                    />
                                    <label htmlFor="export-depth-check" className="text-xs text-gray-300">Export depth</label>
                                  </div>
                                </div>
                              </div>
                            )
                          })() : groupParams.length > 0 && (
                            <div className="grid grid-cols-2 gap-3">
                              {groupParams.map(p => (
                                <ParamField
                                  key={p.key}
                                  p={p}
                                  value={paramValues[p.key] ?? p.value}
                                  onChange={v => setParamValues(prev => ({ ...prev, [p.key]: v }))}
                                  disabled={isPipelineRunning || !isEnabled}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Extra CLI arguments */}
                <Input
                  label="Extra arguments"
                  value={extraCliArgs}
                  onChange={setExtraCliArgs}
                  placeholder="e.g. --trim-start 3 --quality 4"
                  disabled={isPipelineRunning}
                />

              </div>
            )}
          </div>

          

          {/* Launch / Kill buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleStartPipeline}
              disabled={isPipelineRunning || !selectedConfig || !selectedSvo}
              className="flex-1 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl
                         py-2.5 text-sm font-medium transition-colors"
            >
              {isPipelineRunning ? 'Processing…' : 'Launch Pipeline'}
            </button>
            {isPipelineRunning && (
              <button
                onClick={handleKillPipeline}
                className="bg-red-800 hover:bg-red-700 rounded-xl px-4 text-sm font-medium transition-colors"
              >
                Kill
              </button>
            )}
          </div>

          {/* Log console */}
          {pipelineStream.logs.length > 0 && (
            <div ref={logContainerRef} className="log-console bg-gray-950 border border-gray-800 rounded-xl p-3 h-60
                            overflow-y-auto font-mono text-xs leading-relaxed">
              {pipelineStream.logs.map((line, i) => (
                <div
                  key={i}
                  className={
                    /\[ERROR\]|error|Error/.test(line)
                      ? 'text-red-400'
                      : /\[OK\]|\[DONE\]|Done/i.test(line)
                      ? 'text-green-400'
                      : /Step \d/.test(line)
                      ? 'text-blue-300 font-semibold'
                      : 'text-gray-300'
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          )}

          {/* Download ZIP */}
          {zipReady && zipSession && (
            <button
              onClick={async () => {
                if (zipDownloading) return
                setZipDownloading(true)
                try {
                  const r = await fetch(`/api/download/${encodeURIComponent(zipSession)}`)
                  if (!r.ok) {
                    const msg = await r.text().catch(() => r.statusText)
                    throw new Error(`${r.status} ${msg}`)
                  }
                  const blob = await r.blob()
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${zipSession}.zip`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch (err) {
                  toast.error(`Download failed: ${err instanceof Error ? err.message : err}`)
                } finally {
                  setZipDownloading(false)
                }
              }}
              disabled={zipDownloading}
              className="flex items-center justify-center gap-2 w-full bg-indigo-700
                         hover:bg-indigo-600 disabled:bg-gray-700 rounded-xl py-2.5 text-sm font-medium
                         transition-colors"
            >
              {zipDownloading ? <><span className="animate-spin">⏳</span> Downloading…</> : <>↓ Download {zipSession}.zip</>}
            </button>
          )}
        </section>

        {/* ──────────────────── Download Panel ─────────────────── */}
        <section className="bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-5">
          <h2 className="text-lg font-semibold">Download data</h2>

          {/* Session dropdown */}
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Session</label>
            <select
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                         focus:outline-none focus:border-blue-500"
              value={dlSession}
              onFocus={fetchDlSessions}
              onChange={e => {
                const name = e.target.value
                setDlSession(name)
                fetchDlFiles(name)
              }}
            >
              <option value="">— select a session —</option>
              {dlSessions.map(s => <option key={s.name} value={s.name}>{s.name} ({s.date})</option>)}
            </select>
          </div>

          {/* File list */}
          {dlLoading && (
            <p className="text-sm text-gray-400 animate-pulse">Loading files…</p>
          )}

          {!dlLoading && dlFiles.length > 0 && (() => {
            const rawFiles = dlFiles.filter(f => f.group === 'raw')
            const outFiles = dlFiles.filter(f => f.group === 'output')
            const totalSelected = dlFiles.filter(f => dlChecked.has(f.path)).reduce((a, f) => a + f.size, 0)
            const humanTotal = (n: number) => {
              if (n < 1024) return `${n} B`
              if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
              if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
              return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
            }

            const renderGroup = (label: string, files: DlFile[]) => {
              if (files.length === 0) return null
              const allChecked = files.every(f => dlChecked.has(f.path))
              const someChecked = files.some(f => dlChecked.has(f.path))
              const toggleAll = () => {
                setDlChecked(prev => {
                  const next = new Set(prev)
                  if (allChecked) files.forEach(f => next.delete(f.path))
                  else files.forEach(f => next.add(f.path))
                  return next
                })
              }
              return (
                <div key={label} className="space-y-1">
                  {/* Group header with select-all */}
                  <div className="flex items-center gap-2 pb-1 border-b border-gray-700">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = !allChecked && someChecked }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-gray-600 accent-blue-500"
                    />
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</span>
                  </div>
                  {/* File rows */}
                  {files.map(f => (
                    <label key={f.path} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-gray-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={dlChecked.has(f.path)}
                        onChange={e => {
                          setDlChecked(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(f.path)
                            else next.delete(f.path)
                            return next
                          })
                        }}
                        className="h-4 w-4 flex-shrink-0 rounded border-gray-600 accent-blue-500"
                      />
                      <span className="flex-shrink-0 text-gray-500">{f.is_dir ? '📁' : '📄'}</span>
                      <span className="flex-1 text-sm text-gray-200 truncate font-mono">{f.label}</span>
                      <span className="text-xs text-gray-500 flex-shrink-0 tabular-nums">{f.size_human}</span>
                    </label>
                  ))}
                </div>
              )
            }

            const singlePath = dlChecked.size === 1 ? [...dlChecked][0] : null
            const singleFileDef = singlePath ? dlFiles.find(f => f.path === singlePath && !f.is_dir) : undefined

            return (
              <div className="space-y-4">
                {/* Global select/deselect all */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setDlChecked(new Set(dlFiles.map(f => f.path)))}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => setDlChecked(new Set())}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Deselect all
                  </button>
                </div>
                {renderGroup('Raw data', rawFiles)}
                {renderGroup('Pipeline outputs', outFiles)}

                {/* Download button */}
                <button
                  onClick={handleDownload}
                  disabled={dlZipping || dlChecked.size === 0}
                  className="w-full bg-indigo-700 hover:bg-indigo-600 disabled:bg-gray-700
                             rounded-xl py-2.5 text-sm font-medium transition-colors flex
                             items-center justify-center gap-2"
                >
                  {dlZipping
                    ? <><span className="animate-spin">⏳</span> {singleFileDef ? 'Downloading…' : 'Building ZIP…'}</>
                    : singleFileDef
                      ? <>↓ Download {singleFileDef.label} ({humanTotal(totalSelected)})</>
                      : <>↓ Download selection ({dlChecked.size} file{dlChecked.size !== 1 ? 's' : ''}, {humanTotal(totalSelected)})</>
                  }
                </button>
              </div>
            )
          })()}

          {!dlLoading && dlSession && dlFiles.length === 0 && (
            <p className="text-sm text-gray-500">No files found for this session.</p>
          )}
        </section>
      </main>

      {/* ────────────────── New Preset Modal ────────────────── */}
      {showNewPreset && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewPreset(false) }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
              <h3 className="text-lg font-semibold">New preset</h3>
              <button
                onClick={() => setShowNewPreset(false)}
                className="text-gray-400 hover:text-white text-xl leading-none"
              >✕</button>
            </div>
            {/* Modal body */}
            <div className="overflow-y-auto px-6 py-5 space-y-5 flex-1">
              <Input
                label="Preset name"
                value={newPresetName}
                onChange={setNewPresetName}
                placeholder="e.g. corridor"
                disabled={newPresetSaving}
              />
              {/* Pipeline parameters */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pipeline parameters</p>
                <div className="grid grid-cols-2 gap-3">
                  {ALL_KNOWN_PARAMS.map(p => (
                    <ParamField
                      key={p.key} p={p}
                      value={newPresetParams[p.key] ?? p.value}
                      onChange={v => setNewPresetParams(prev => ({ ...prev, [p.key]: v }))}
                      disabled={newPresetSaving}
                    />
                  ))}
                </div>
              </div>
              {/* RTAB-Map parameters */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">RTAB-Map parameters</p>
                  <button
                    onClick={() => setNewPresetRtabmap(prev => [...prev, { k: '', v: '' }])}
                    disabled={newPresetSaving}
                    className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors"
                  >+ Add row</button>
                </div>
                {newPresetRtabmap.length === 0 && (
                  <p className="text-xs text-gray-500">No RTAB-Map parameters — click “+ Add row” to add one.</p>
                )}
                <div className="space-y-1.5">
                  {newPresetRtabmap.map((row, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        value={row.k}
                        onChange={e => setNewPresetRtabmap(prev => prev.map((r, j) => j === i ? { ...r, k: e.target.value } : r))}
                        placeholder="Optimizer/Strategy"
                        disabled={newPresetSaving}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono
                                   focus:outline-none focus:border-blue-500 disabled:opacity-40"
                      />
                      <input
                        value={row.v}
                        onChange={e => setNewPresetRtabmap(prev => prev.map((r, j) => j === i ? { ...r, v: e.target.value } : r))}
                        placeholder="value"
                        disabled={newPresetSaving}
                        className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono
                                   focus:outline-none focus:border-blue-500 disabled:opacity-40"
                      />
                      <button
                        onClick={() => setNewPresetRtabmap(prev => prev.filter((_, j) => j !== i))}
                        disabled={newPresetSaving}
                        className="text-gray-500 hover:text-red-400 disabled:opacity-40 transition-colors px-1"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Modal footer */}
            <div className="flex gap-3 justify-end px-6 py-4 border-t border-gray-800 flex-shrink-0">
              <button
                onClick={() => setShowNewPreset(false)}
                disabled={newPresetSaving}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white transition-colors disabled:opacity-40"
              >Cancel</button>
              <button
                onClick={handleSavePreset}
                disabled={newPresetSaving || !newPresetName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded-xl text-sm font-medium transition-colors"
              >
                {newPresetSaving ? 'Saving…' : 'Save preset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-6 py-8">
        <div className="max-w-7xl mx-auto px-6 flex flex-col items-center gap-3">
          <img src="/logo.png" alt="Intuitive Robots" className="h-14 w-auto opacity-80" />
          <p className="text-sm text-gray-500">© {new Date().getFullYear()} Intuitive Robots. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
