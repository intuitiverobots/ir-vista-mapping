import { useState, useEffect } from 'react'

export function useLogStream(url: string | null): { logs: string[]; exitCode: number | null } {
  const [logs, setLogs] = useState<string[]>([])
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    if (!url) return
    setLogs([])
    setExitCode(null)
    const sse = new EventSource(url)
    sse.onmessage = (e: MessageEvent<string>) => {
      const data = e.data
      if (data.startsWith('[DONE] exit=')) {
        const m = data.match(/exit=(-?\d+)/)
        setExitCode(m ? parseInt(m[1]) : -1)
        sse.close()
      } else if (data && !data.startsWith(':')) {
        setLogs(prev => [...prev, data])
      }
    }
    sse.onerror = () => sse.close()
    return () => sse.close()
  }, [url])

  return { logs, exitCode }
}
